package cdc

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// A Postgres with wal_level=logical (the repository's docker compose); skipped where there is none.
func adminURL() string {
	if u := os.Getenv("SILO_TEST_PG_URL"); u != "" {
		return u
	}
	return "postgres://postgres:postgres@127.0.0.1:55432/postgres?sslmode=disable"
}

func withDatabase(u, name string) string {
	parsed, _ := url.Parse(u)
	parsed.Path = "/" + name
	return parsed.String()
}

// sweepTestSlots drops a test's replication slots and then its database: db's, or with db
// empty, whatever a killed run left (its slots inactive and its databases slotless, so never a
// run going on now). A slot left behind keeps every byte of WAL written after it, so one that
// will not go fails the test rather than quietly filling the disk.
func sweepTestSlots(ctx context.Context, t *testing.T, admin *pgx.Conn, db string) {
	t.Helper()
	mine := db != ""
	pattern := db
	if !mine {
		pattern = `cdc\_test\_%`
	}
	left := 0
	for deadline := time.Now().Add(15 * time.Second); ; time.Sleep(200 * time.Millisecond) {
		if mine {
			// An active slot cannot be dropped: end whatever reader still holds it.
			_, _ = admin.Exec(ctx, "select pg_terminate_backend(active_pid) from pg_replication_slots where database like $1 and active_pid is not null", pattern)
		}
		_, _ = admin.Exec(ctx, "select pg_drop_replication_slot(slot_name) from pg_replication_slots where database like $1 and not active", pattern)
		if err := admin.QueryRow(ctx, "select count(*) from pg_replication_slots where database like $1 and (not active or $2)", pattern, mine).Scan(&left); err != nil {
			t.Errorf("counting the test's replication slots: %v", err)
			return
		}
		if left == 0 || time.Now().After(deadline) {
			break
		}
	}
	report := t.Logf
	if mine {
		report = t.Errorf
	}
	if left != 0 {
		report("%d replication slots in %s would not drop: they hold WAL until they do", left, pattern)
	}
	rows, err := admin.Query(ctx, `select datname from pg_database d where datname like $1
		and not exists (select 1 from pg_replication_slots s where s.database = d.datname)`, pattern)
	if err != nil {
		report("listing test databases: %v", err)
		return
	}
	names, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		report("listing test databases: %v", err)
		return
	}
	for _, name := range names {
		if _, err := admin.Exec(ctx, "drop database if exists "+pgx.Identifier{name}.Sanitize()+" with (force)"); err != nil {
			report("dropping %s: %v", name, err)
		}
	}
}

func TestPostgresChangesInCommitOrderResumingFromTheAcknowledgedPosition(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, adminURL())
	if err != nil {
		t.Skip("no Postgres here:", err)
	}
	defer admin.Close(context.Background())
	var level string
	if err := admin.QueryRow(ctx, "show wal_level").Scan(&level); err != nil || level != "logical" {
		t.Skip("Postgres is not set for logical replication")
	}
	// What a killed run left: its defers never ran, and its slot would hold WAL for ever.
	sweepTestSlots(ctx, t, admin, "")
	db := fmt.Sprintf("cdc_test_%d", os.Getpid())
	slot := fmt.Sprintf("silo_test_%d", os.Getpid())
	if _, err := admin.Exec(ctx, "create database "+db); err != nil {
		t.Fatal(err)
	}
	defer sweepTestSlots(context.Background(), t, admin, db)
	dsn := withDatabase(adminURL(), db)
	source, err := pgx.Connect(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer source.Close(context.Background())
	if _, err := source.Exec(ctx, `create table items (id int primary key, name text not null, price numeric(10,2), seen date);
		create publication silo_pub for table items`); err != nil {
		t.Fatal(err)
	}

	var out io.Writer = io.Discard
	if os.Getenv("CDC_DEBUG") != "" {
		out = os.Stderr
	}
	logger := slog.New(slog.NewTextHandler(out, &slog.HandlerOptions{Level: slog.LevelDebug}))
	start := func(from string) (chan Batch, context.CancelFunc, *Postgres) {
		batches := make(chan Batch, 10)
		rctx, stop := context.WithCancel(ctx)
		reader := &Postgres{DSN: dsn, SlotName: slot, Publication: "silo_pub", Start: from, Logger: logger, StatusEvery: 200 * time.Millisecond,
			Emit: func(b Batch) error { batches <- b; return nil }, Started: func() error { return nil }}
		go func() {
			if err := reader.Run(rctx); err != nil {
				t.Logf("reader stopped: %v", err)
			}
		}()
		return batches, stop, reader
	}
	// The next batch with changes: positions alone (markers) move the acknowledged position on.
	next := func(batches chan Batch) Batch {
		for {
			select {
			case b := <-batches:
				if len(b.Changes) == 0 {
					if b.Position == "" || b.Order == 0 {
						t.Fatalf("a marker carries its position: %+v", b)
					}
					continue
				}
				return b
			case <-time.After(15 * time.Second):
				t.Fatal("no batch came")
				return Batch{}
			}
		}
	}

	batches, stop, reader := start("")
	// The changes are made only once the slot streams: making a logical slot waits for every
	// transaction already running on the server, which on a busy one takes a while.
	deadline := time.Now().Add(45 * time.Second)
	for {
		var n int
		_ = admin.QueryRow(ctx, "select count(*) from pg_replication_slots where slot_name = $1 and active", slot).Scan(&n)
		if n == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the slot never started streaming")
		}
		time.Sleep(50 * time.Millisecond)
	}
	for _, statement := range []string{
		"insert into items values (1, 'pump', 12.50, '2026-11-01'), (2, 'valve', 3.20, null)",
		"update items set price = 13.00 where id = 1",
		"delete from items where id = 2",
	} {
		if _, err := source.Exec(ctx, statement); err != nil {
			t.Fatal(err)
		}
	}
	first := next(batches)
	if len(first.Changes) != 2 || first.Changes[0].Op != "insert" || first.Changes[0].Table != "items" || first.Changes[0].Schema != "public" {
		t.Fatalf("first transaction: %+v", first)
	}
	if v := first.Changes[0].Values; v["id"] != int32(1) || v["name"] != "pump" || v["price"] != "12.50" || v["seen"] != "2026-11-01" {
		t.Fatalf("values as the cell reads them: %#v", v)
	}
	if first.Changes[1].Values["seen"] != nil {
		t.Fatalf("null stays null: %#v", first.Changes[1].Values)
	}
	second := next(batches)
	if len(second.Changes) != 1 || second.Changes[0].Op != "update" || second.Changes[0].Values["price"] != "13.00" {
		t.Fatalf("second transaction: %+v", second)
	}
	// Each change's place in the log sorts as text: within a transaction, and across them.
	if !(first.Changes[0].Position < first.Changes[1].Position && first.Changes[1].Position < second.Changes[0].Position) {
		t.Fatalf("change positions in log order: %q %q %q", first.Changes[0].Position, first.Changes[1].Position, second.Changes[0].Position)
	}
	if first.Position == "" || second.Position == "" {
		t.Fatal("a whole transaction carries the position to acknowledge")
	}
	if err := reader.Ack(second.Position); err != nil {
		t.Fatal(err)
	}
	third := next(batches)
	if len(third.Changes) != 1 || third.Changes[0].Op != "delete" || third.Changes[0].Values["id"] != int32(2) {
		t.Fatalf("third transaction: %+v", third)
	}
	// Let Postgres hear the acknowledged position, then stop: the next reader starts after it.
	time.Sleep(500 * time.Millisecond)
	stop()
	// A slot serves one reader at a time: the next starts once Postgres has let the first go.
	released := time.Now().Add(30 * time.Second)
	for {
		var active bool
		_ = admin.QueryRow(ctx, "select active from pg_replication_slots where slot_name = $1", slot).Scan(&active)
		if !active {
			break
		}
		if time.Now().After(released) {
			t.Fatal("the slot was never released")
		}
		time.Sleep(50 * time.Millisecond)
	}

	resumed, stopResumed, _ := start(second.Position)
	again := next(resumed)
	if len(again.Changes) != 1 || again.Changes[0].Op != "delete" {
		t.Fatalf("resumed from the acknowledged position, the delete comes again and nothing before it: %+v", again)
	}
	quiet := time.After(time.Second)
	for waiting := true; waiting; {
		select {
		case extra := <-resumed:
			if len(extra.Changes) > 0 {
				t.Fatalf("nothing else: %+v", extra)
			}
		case <-quiet:
			waiting = false
		}
	}

	// A large transaction comes in parts; only the last carries the position.
	if _, err := source.Exec(ctx, "insert into items select g, 'bulk', 1.00, null from generate_series(100, 1299) g"); err != nil {
		t.Fatal(err)
	}
	var parts []Batch
	for total := 0; total < 1200; {
		part := next(resumed)
		parts = append(parts, part)
		total += len(part.Changes)
	}
	if len(parts) != 3 || len(parts[0].Changes) != ChangesPerBatch || parts[0].Position != "" || parts[1].Position != "" || parts[2].Position == "" || parts[2].Changes == nil {
		t.Fatalf("the transaction in parts of %d, the last acknowledgeable: %d parts", ChangesPerBatch, len(parts))
	}
	if !(parts[0].Changes[499].Position < parts[1].Changes[0].Position) {
		t.Fatal("positions run on across the parts")
	}
	stopResumed()

	// Resuming a slot that is gone never makes it again: it is lost.
	lost := &Postgres{DSN: dsn, SlotName: slot + "_gone", Publication: "silo_pub", Start: second.Position, Logger: logger,
		Emit: func(Batch) error { return nil }}
	if err := lost.Run(ctx); !errors.Is(err, ErrLost) {
		t.Fatalf("a missing slot resumed is lost: %v", err)
	}

	// Dropping waits for the reader to let the slot go; a slot already gone is dropped.
	dctx, cancelDrop := context.WithTimeout(ctx, 60*time.Second)
	defer cancelDrop()
	if err := DropSlot(dctx, dsn, slot); err != nil {
		t.Fatalf("drop: %v", err)
	}
	var left int
	_ = admin.QueryRow(ctx, "select count(*) from pg_replication_slots where slot_name = $1", slot).Scan(&left)
	if left != 0 {
		t.Fatal("the slot is gone from the source")
	}
	if err := DropSlot(dctx, dsn, slot); err != nil {
		t.Fatalf("dropping it again: %v", err)
	}
}
