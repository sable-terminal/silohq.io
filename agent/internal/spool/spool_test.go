package spool

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const slot = "01a1e000-0000-7000-8000-000000000001"

func frame(i int) []byte {
	return []byte(fmt.Sprintf(`{"type":"changes","values":"secret-value-%04d-%s"}`, i, strings.Repeat("x", 200)))
}

func appendN(t *testing.T, q *Queue, from, n int, at time.Time) {
	t.Helper()
	for i := from; i < from+n; i++ {
		if err := q.Append(Record{Order: uint64(i), Final: true, Position: fmt.Sprintf("0/%X", i), CommittedAt: at, Changes: 2, Frame: frame(i)}, true); err != nil {
			t.Fatal(err)
		}
	}
}

func next(t *testing.T, c *Cursor) Record {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	rec, err := c.Next(ctx)
	if err != nil {
		t.Fatalf("next: %v", err)
	}
	return rec
}

func TestRecordsLeaveInOrderSealedAndGoOnceAcknowledged(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	q, _ := s.Queue(slot)
	appendN(t, q, 1, 3, time.Now())
	c := q.Cursor()
	for i := 1; i <= 3; i++ {
		rec := next(t, c)
		if rec.Order != uint64(i) || !bytes.Equal(rec.Frame, frame(i)) || rec.Position != fmt.Sprintf("0/%X", i) || rec.Changes != 2 {
			t.Fatalf("record %d: %+v", i, rec)
		}
	}
	// On disk, nothing of the values, and the host key readable by the agent alone.
	_ = s.Sync()
	segs, _ := filepath.Glob(filepath.Join(dir, slot, "*.seg"))
	for _, path := range segs {
		raw, _ := os.ReadFile(path)
		if bytes.Contains(raw, []byte("secret-value")) {
			t.Fatal("a value is on disk in clear")
		}
	}
	if info, _ := os.Stat(filepath.Join(dir, keyFile)); info.Mode().Perm() != 0o600 {
		t.Fatalf("host key mode %v", info.Mode().Perm())
	}
	if order, pos := q.LastFinal(); order != 3 || pos != "0/3" {
		t.Fatalf("last final %d %s", order, pos)
	}

	// A record appended later reaches a waiting cursor.
	got := make(chan Record, 1)
	go func() { got <- next(t, c) }()
	time.Sleep(50 * time.Millisecond)
	appendN(t, q, 4, 1, time.Now())
	if rec := <-got; rec.Order != 4 {
		t.Fatalf("waited for %d", rec.Order)
	}

	q.Ack(4)
	if q.Pending() || s.Bytes() != 0 {
		t.Fatalf("acknowledged records stay: pending %v, %d bytes", q.Pending(), s.Bytes())
	}
	// A new segment after everything went has a fresh salt: a key and nonce never repeat.
	appendN(t, q, 5, 1, time.Now())
	segs, _ = filepath.Glob(filepath.Join(dir, slot, "*.seg"))
	if len(segs) != 1 || strings.HasSuffix(segs[0], "0000000000000001.seg") {
		t.Fatalf("segments after a full acknowledgement: %v", segs)
	}
}

func TestTheCellsReceiptsLetRecordsGoWithoutAPosition(t *testing.T) {
	s, _ := Open(t.TempDir(), 256<<10, 0)
	q, _ := s.Queue(slot)
	// One transaction larger than the spool: parts with no position to acknowledge.
	var refused error
	part := func(i int) error {
		return q.Append(Record{Order: 100, CommittedAt: time.Now(), Changes: 500, Frame: frame(i)}, false)
	}
	i := 0
	for ; refused == nil && i < 5000; i++ {
		refused = part(i)
	}
	if refused != ErrFull {
		t.Fatalf("expected the bound: %v", refused)
	}
	c := q.Cursor()
	var last Record
	for n := 0; n < 300; n++ {
		last = next(t, c)
	}
	if _, _, ok := ParseID(last.ID); !ok {
		t.Fatalf("a record carries its id: %q", last.ID)
	}
	q.Received(last.ID)
	if err := part(i); err != nil {
		t.Fatalf("receipts make room for the rest of the transaction: %v", err)
	}
	if rec := next(t, c); rec.ID == last.ID {
		t.Fatal("the cursor goes on past what was received")
	}
	if fresh := next(t, q.Cursor()); fresh.ID == last.ID {
		t.Fatal("a new cursor starts after what was received")
	}
}

func TestReopenedSpoolKeepsWhatWasNotAcknowledged(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir, 0, 0)
	q, _ := s.Queue(slot)
	appendN(t, q, 1, 5, time.Now())
	_ = q.SourceConfirmed(5)
	_ = q.AddGap(Gap{Reason: "resumed_ahead"})
	_ = s.Sync()

	again, err := Open(dir, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if slots := again.Slots(); len(slots) != 1 || slots[0] != slot {
		t.Fatalf("slots %v", slots)
	}
	q2, _ := again.Queue(slot)
	if !q2.Precious() {
		t.Fatal("records the source let go of are precious")
	}
	if gaps := q2.Gaps(); len(gaps) != 1 || gaps[0].Reason != "resumed_ahead" {
		t.Fatalf("gaps %+v", gaps)
	}
	c := q2.Cursor()
	for i := 1; i <= 5; i++ {
		if rec := next(t, c); rec.Order != uint64(i) {
			t.Fatalf("after reopening, record %d is %d", i, rec.Order)
		}
	}
	if order, pos := q2.Synced(); order != 5 || pos != "0/5" {
		t.Fatalf("synced %d %s", order, pos)
	}
	_ = q2.AckGap(q2.Gaps()[0].ID)
	if len(q2.Gaps()) != 0 {
		t.Fatal("an acknowledged gap goes")
	}
}

func TestTheBoundDropsTheOldestAsAGapRecord(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir, 256<<10, 0) // 64 KiB segments
	q, _ := s.Queue(slot)
	early := time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC)
	appendN(t, q, 1, 400, early)
	appendN(t, q, 401, 1200, early.Add(time.Hour))
	if s.Bytes() > 256<<10 {
		t.Fatalf("over the bound: %d", s.Bytes())
	}
	gaps := q.Gaps()
	if len(gaps) == 0 {
		t.Fatal("no gap recorded")
	}
	var records, changes int
	for _, g := range gaps {
		if g.Reason != "spool_bound" || g.From.IsZero() || g.To.Before(g.From) {
			t.Fatalf("gap %+v", g)
		}
		records += g.Records
		changes += g.Changes
	}
	if changes != 2*records || !gaps[0].From.Equal(early) {
		t.Fatalf("counts and the time range: %d records, %d changes, from %v", records, changes, gaps[0].From)
	}
	// What is left reads in order, from where the drop left off.
	first := next(t, q.Cursor())
	if first.Order != uint64(records+1) {
		t.Fatalf("first after the gap %d, %d dropped", first.Order, records)
	}
}

func TestAtTheSizeBoundAnAppendWaitsUnlessDroppingIsAllowed(t *testing.T) {
	s, _ := Open(t.TempDir(), 256<<10, 0)
	q, _ := s.Queue(slot)
	var refused error
	for i := 1; i < 5000 && refused == nil; i++ {
		refused = q.Append(Record{Order: uint64(i), Final: true, Position: fmt.Sprintf("0/%X", i), CommittedAt: time.Now(), Changes: 1, Frame: frame(i)}, false)
	}
	if refused != ErrFull || len(q.Gaps()) != 0 || s.Bytes() > 256<<10 {
		t.Fatalf("refused %v, gaps %d, %d bytes", refused, len(q.Gaps()), s.Bytes())
	}
	// The cell acknowledging makes room.
	q.Ack(600)
	if err := q.Append(Record{Order: 9000, Final: true, Position: "0/2328", CommittedAt: time.Now(), Changes: 1, Frame: frame(9000)}, false); err != nil {
		t.Fatalf("after an acknowledgement: %v", err)
	}
}

func TestTheAgeBoundDropsWhatWaitedTooLong(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir, 0, time.Hour)
	clock := time.Now()
	s.now = func() time.Time { return clock }
	q, _ := s.Queue(slot)
	appendN(t, q, 1, 3, clock)
	clock = clock.Add(2 * time.Hour)
	_ = s.Sync()
	if gaps := q.Gaps(); len(gaps) != 1 || gaps[0].Reason != "spool_age" || gaps[0].Records != 3 {
		t.Fatalf("gaps %+v", gaps)
	}
}

func TestATamperedRecordEndsItsSegmentAndIsAGap(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir, 0, 0)
	q, _ := s.Queue(slot)
	appendN(t, q, 1, 3, time.Now())
	_ = s.Sync()
	segs, _ := filepath.Glob(filepath.Join(dir, slot, "*.seg"))
	raw, _ := os.ReadFile(segs[0])
	raw[len(raw)-5] ^= 0xff // inside the last record's sealed data
	_ = os.WriteFile(segs[0], raw, 0o600)

	again, _ := Open(dir, 0, 0)
	q2, _ := again.Queue(slot)
	if gaps := q2.Gaps(); len(gaps) != 1 || gaps[0].Reason != "spool_damaged" {
		t.Fatalf("gaps %+v", gaps)
	}
	c := q2.Cursor()
	if next(t, c).Order != 1 || next(t, c).Order != 2 {
		t.Fatal("the records before the damage still read")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, err := c.Next(ctx); err == nil {
		t.Fatal("the damaged record is gone")
	}
}
