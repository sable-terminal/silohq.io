// Package spool is the agent's store-and-forward (spec 10.6): change events wait here, on the
// agent's host, until the cell acknowledges them.
//
//   - One queue per capture slot, in append-only segment files under the state directory.
//     Each record's change data is sealed with AES-256-GCM under a key derived (HKDF-SHA-256)
//     from the host key and the segment's own random salt, with the record's index as its
//     nonce, so no key and nonce pair ever repeats. Its header (log order, position, commit time, change count) is not a record
//     value, so it stays readable for bounds and gap records, and is authenticated with it.
//   - Bounded at 10 GB or 7 days by default (30 days for air-gapped sites), across all
//     queues. At the size bound an append is refused (ErrFull) while the source still holds
//     what the spool holds, so the reader waits rather than lose anything; only where the
//     caller allows it (the source is about to let it go anyway) does the oldest segment go.
//     Past the age bound the oldest goes. What a dropped segment held unacknowledged becomes a
//     gap record, counts and a time range, no values, kept until the cell has it.
//   - Records leave in log order, each with its own id (ID: segment and index), and are deleted
//     once the cell has them: it receipts every record, a part of a large transaction included,
//     so a transaction larger than the spool still passes through; a position the cell
//     acknowledges also lets go of what lies at or before it. A record that does not open (tampered, or torn by a crash) ends its segment
//     there, and what is lost is a gap too.
package spool

import (
	"bufio"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	// DefaultMaxBytes and the default ages are spec 10.6's bounds.
	DefaultMaxBytes = 10 << 30
	DefaultMaxAge   = 7 * 24 * time.Hour
	AirGappedMaxAge = 30 * 24 * time.Hour
	minSegmentBytes = 64 << 10
	maxSegmentBytes = 64 << 20
	headerFixed     = 8 + 1 + 8 + 8 + 4 + 1
	flagFinal       = 1
	maxRecordBytes  = 8 << 20
	keyFile         = "host.key"
	gapsFile        = "gaps.json"
	metaFile        = "meta.json"
	segmentSuffix   = ".seg"
	saltBytes       = 16
)

var slotName = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// ErrClosed is a queue removed while in use.
var ErrClosed = errors.New("the spool queue was removed")

// ErrFull is an append the size bound refused: wait for the cell to acknowledge, and try again.
var ErrFull = errors.New("the spool is full")

// Record is one change event as it waits: Frame is what goes up, the rest describes it.
type Record struct {
	// Order sorts records in log order (an LSN); Position is the text to acknowledge, on a final record.
	Order       uint64
	Final       bool
	Position    string
	CommittedAt time.Time
	Changes     int
	Frame       []byte
	// ID names the record in its queue, in order: "<segment>.<index>".
	ID        string
	spooledAt time.Time
}

// ParseID reads a record id.
func ParseID(id string) (seq, index uint64, ok bool) {
	a, b, found := strings.Cut(id, ".")
	if !found {
		return 0, 0, false
	}
	seq, err1 := strconv.ParseUint(a, 10, 64)
	index, err2 := strconv.ParseUint(b, 10, 64)
	return seq, index, err1 == nil && err2 == nil
}

// Gap is what the spool dropped: counts and a time range, no values.
type Gap struct {
	ID     string `json:"id"`
	Reason string `json:"reason"`
	// Changes and Records are -1 where they cannot be known (a damaged record, a resumed reader).
	Changes      int       `json:"changes"`
	Records      int       `json:"records"`
	From         time.Time `json:"from"`
	To           time.Time `json:"to"`
	FromPosition string    `json:"fromPosition,omitempty"`
	ToPosition   string    `json:"toPosition,omitempty"`
}

type segment struct {
	seq         uint64
	salt        []byte
	path        string
	size        int64
	records     int
	firstOrder  uint64
	lastOrder   uint64
	lastSpooled time.Time
	finalOrder  uint64
	finalPos    string
}

// Store is every queue of one agent.
type Store struct {
	dir          string
	hostKey      []byte
	maxBytes     int64
	maxAge       time.Duration
	segmentBytes int64
	now          func() time.Time
	total        atomic.Int64
	mu           sync.Mutex
	queues       map[string]*Queue
}

// Open opens the spool under dir, making its host key on first use.
func Open(dir string, maxBytes int64, maxAge time.Duration) (*Store, error) {
	if maxBytes <= 0 {
		maxBytes = DefaultMaxBytes
	}
	if maxAge <= 0 {
		maxAge = DefaultMaxAge
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	key, err := hostKey(filepath.Join(dir, keyFile))
	if err != nil {
		return nil, err
	}
	s := &Store{dir: dir, hostKey: key, maxBytes: maxBytes, maxAge: maxAge, now: time.Now, queues: map[string]*Queue{},
		segmentBytes: min(max(maxBytes/16, minSegmentBytes), maxSegmentBytes)}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	for _, e := range entries {
		if e.IsDir() && slotName.MatchString(e.Name()) {
			if _, err := s.Queue(e.Name()); err != nil {
				return nil, fmt.Errorf("spool queue %s: %w", e.Name(), err)
			}
		}
	}
	return s, nil
}

func hostKey(path string) ([]byte, error) {
	raw, err := os.ReadFile(path)
	if err == nil {
		key, err := hex.DecodeString(strings.TrimSpace(string(raw)))
		if err != nil || len(key) != 32 {
			return nil, errors.New("the spool's host key is not 32 bytes of hex")
		}
		return key, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	if err := os.WriteFile(path, []byte(hex.EncodeToString(key)+"\n"), 0o600); err != nil {
		return nil, err
	}
	return key, nil
}

// Bytes is the spool's size on disk.
func (s *Store) Bytes() int64 { return s.total.Load() }

// Slots are the slots with a queue.
func (s *Store) Slots() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.queues))
	for slot := range s.queues {
		out = append(out, slot)
	}
	sort.Strings(out)
	return out
}

// Queue is the slot's queue, opened from disk or made.
func (s *Store) Queue(slot string) (*Queue, error) {
	if !slotName.MatchString(slot) {
		return nil, errors.New("a spool queue is named by its slot id")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if q := s.queues[slot]; q != nil {
		return q, nil
	}
	q := &Queue{store: s, slot: slot, dir: filepath.Join(s.dir, slot), notify: make(chan struct{})}
	if err := q.load(); err != nil {
		return nil, err
	}
	s.queues[slot] = q
	return q, nil
}

// Remove deletes the slot's queue and everything in it.
func (s *Store) Remove(slot string) error {
	s.mu.Lock()
	q := s.queues[slot]
	delete(s.queues, slot)
	s.mu.Unlock()
	if q == nil {
		return nil
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	q.closeActive()
	for _, seg := range q.segs {
		s.total.Add(-seg.size)
	}
	q.segs = nil
	q.removed = true
	q.wake()
	return os.RemoveAll(q.dir)
}

// Sync makes every queue's appended records durable, and drops what has outlived the age bound.
func (s *Store) Sync() error {
	s.mu.Lock()
	queues := make([]*Queue, 0, len(s.queues))
	for _, q := range s.queues {
		queues = append(queues, q)
	}
	s.mu.Unlock()
	var first error
	for _, q := range queues {
		if err := q.sync(); err != nil && first == nil {
			first = err
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.enforce(false)
	return first
}

// enforce drops oldest segments past the age bound, and past the size bound where dropBySize; s.mu is held.
func (s *Store) enforce(dropBySize bool) {
	cutoff := s.now().Add(-s.maxAge)
	for {
		var victim *Queue
		var oldest time.Time
		for _, q := range s.queues {
			q.mu.Lock()
			if len(q.segs) > 0 && (victim == nil || q.segs[0].lastSpooled.Before(oldest)) {
				victim, oldest = q, q.segs[0].lastSpooled
			}
			q.mu.Unlock()
		}
		if victim == nil {
			return
		}
		overSize := dropBySize && s.total.Load() > s.maxBytes
		overAge := oldest.Before(cutoff)
		if !overSize && !overAge {
			return
		}
		reason := "spool_bound"
		if !overSize {
			reason = "spool_age"
		}
		if !victim.dropOldest(reason) {
			return
		}
	}
}

// Queue is one slot's records.
type Queue struct {
	store           *Store
	slot            string
	dir             string
	mu              sync.Mutex
	segs            []*segment
	active          *os.File
	activeIndex     uint64
	lastSeq         uint64
	dirty           bool
	acked           uint64
	receivedSeq     uint64
	receivedIndex   uint64
	received        bool
	syncedOrder     uint64
	syncedPos       string
	sourceConfirmed uint64
	gaps            []Gap
	notify          chan struct{}
	removed         bool
}

type meta struct {
	SourceConfirmed uint64 `json:"sourceConfirmed"`
}

func (q *Queue) load() error {
	if err := os.MkdirAll(q.dir, 0o700); err != nil {
		return err
	}
	entries, err := os.ReadDir(q.dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, segmentSuffix) {
			continue
		}
		seq, err := strconv.ParseUint(strings.TrimSuffix(name, segmentSuffix), 10, 64)
		if err != nil {
			continue
		}
		seg := &segment{seq: seq, path: filepath.Join(q.dir, name)}
		if err := q.scan(seg); err != nil {
			return err
		}
		if seg.records == 0 {
			_ = os.Remove(seg.path)
			continue
		}
		q.segs = append(q.segs, seg)
		q.store.total.Add(seg.size)
		q.lastSeq = max(q.lastSeq, seq)
	}
	sort.Slice(q.segs, func(i, j int) bool { return q.segs[i].seq < q.segs[j].seq })
	if raw, err := os.ReadFile(filepath.Join(q.dir, gapsFile)); err == nil {
		_ = json.Unmarshal(raw, &q.gaps)
	}
	if raw, err := os.ReadFile(filepath.Join(q.dir, metaFile)); err == nil {
		var m meta
		if json.Unmarshal(raw, &m) == nil {
			q.sourceConfirmed = m.SourceConfirmed
		}
	}
	for _, seg := range q.segs {
		if seg.finalOrder > 0 {
			q.syncedOrder, q.syncedPos = seg.finalOrder, seg.finalPos
		}
	}
	return nil
}

// scan reads a segment's headers, opening each record; a record that does not open ends the
// segment there, and what follows is a gap.
func (q *Queue) scan(seg *segment) error {
	f, err := os.OpenFile(seg.path, os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	seg.salt = make([]byte, saltBytes)
	if _, err := io.ReadFull(f, seg.salt); err != nil {
		// Made but never written to: nothing in it.
		return f.Truncate(0)
	}
	aead, err := q.aead(seg)
	if err != nil {
		return err
	}
	r := bufio.NewReader(f)
	off := int64(saltBytes)
	var index uint64
	for {
		rec, n, err := readRecord(r, aead, q.slot, index)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			// Torn by a crash, or tampered: the segment ends at the last good record.
			if info, statErr := f.Stat(); statErr == nil && info.Size() > off {
				_ = q.addGapLocked(Gap{Reason: "spool_damaged", Records: -1, Changes: -1})
			}
			if err := f.Truncate(off); err != nil {
				return err
			}
			break
		}
		off += n
		index++
		if seg.records == 0 {
			seg.firstOrder = rec.Order
		}
		seg.records++
		seg.lastOrder = rec.Order
		seg.lastSpooled = rec.spooledAt
		if rec.Final {
			seg.finalOrder, seg.finalPos = rec.Order, rec.Position
		}
	}
	seg.size = off
	return nil
}

func (q *Queue) aead(seg *segment) (cipher.AEAD, error) {
	key, err := hkdf.Key(sha256.New, q.store.hostKey, seg.salt, "silo-agent spool "+q.slot, 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func nonce(index uint64) []byte {
	n := make([]byte, 12)
	binary.BigEndian.PutUint64(n[4:], index)
	return n
}

func header(rec Record, spooledAt time.Time) []byte {
	h := make([]byte, headerFixed, headerFixed+len(rec.Position))
	binary.BigEndian.PutUint64(h[0:], rec.Order)
	if rec.Final {
		h[8] = flagFinal
	}
	binary.BigEndian.PutUint64(h[9:], uint64(rec.CommittedAt.UnixNano()))
	binary.BigEndian.PutUint64(h[17:], uint64(spooledAt.UnixNano()))
	binary.BigEndian.PutUint32(h[25:], uint32(rec.Changes))
	h[29] = byte(len(rec.Position))
	return append(h, rec.Position...)
}

func aad(slot string, h []byte) []byte { return append([]byte(slot), h...) }

// readRecord reads and opens one record: its size on disk.
func readRecord(r io.Reader, aead cipher.AEAD, slot string, index uint64) (Record, int64, error) {
	var lengths [6]byte
	if _, err := io.ReadFull(r, lengths[:]); err != nil {
		if errors.Is(err, io.EOF) {
			return Record{}, 0, io.EOF
		}
		return Record{}, 0, fmt.Errorf("a torn record: %w", err)
	}
	total := binary.BigEndian.Uint32(lengths[0:])
	hlen := binary.BigEndian.Uint16(lengths[4:])
	if total > maxRecordBytes || uint32(hlen) > total || hlen < headerFixed {
		return Record{}, 0, errors.New("a record's lengths are out of bounds")
	}
	body := make([]byte, total)
	if _, err := io.ReadFull(r, body); err != nil {
		return Record{}, 0, fmt.Errorf("a torn record: %w", err)
	}
	h, sealed := body[:hlen], body[hlen:]
	posLen := int(h[29])
	if headerFixed+posLen != int(hlen) {
		return Record{}, 0, errors.New("a record's header does not add up")
	}
	frame, err := aead.Open(nil, nonce(index), sealed, aad(slot, h))
	if err != nil {
		return Record{}, 0, errors.New("a record does not open: tampered or damaged")
	}
	rec := Record{
		Order: binary.BigEndian.Uint64(h[0:]), Final: h[8]&flagFinal != 0,
		CommittedAt: time.Unix(0, int64(binary.BigEndian.Uint64(h[9:]))).UTC(),
		spooledAt:   time.Unix(0, int64(binary.BigEndian.Uint64(h[17:]))).UTC(),
		Changes:     int(binary.BigEndian.Uint32(h[25:])), Position: string(h[headerFixed:]), Frame: frame,
	}
	return rec, int64(6 + total), nil
}

func (q *Queue) wake() {
	close(q.notify)
	q.notify = make(chan struct{})
}

func (q *Queue) closeActive() {
	if q.active != nil {
		_ = q.active.Sync()
		_ = q.active.Close()
		q.active = nil
	}
}

// Append adds a record at the queue's end. At the size bound it is refused (ErrFull), unless
// mayDrop: then it goes in and the oldest segments go, as gap records.
func (q *Queue) Append(rec Record, mayDrop bool) error {
	if len(rec.Position) > 255 {
		return errors.New("a position is at most 255 bytes")
	}
	q.store.mu.Lock()
	defer q.store.mu.Unlock()
	if !mayDrop && q.store.total.Load()+int64(len(rec.Frame))+headerFixed+64 > q.store.maxBytes {
		return ErrFull
	}
	if err := q.append(rec); err != nil {
		return err
	}
	q.store.enforce(mayDrop)
	return nil
}

func (q *Queue) append(rec Record) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.removed {
		return ErrClosed
	}
	if q.active == nil || len(q.segs) == 0 || q.segs[len(q.segs)-1].size >= q.store.segmentBytes {
		q.closeActive()
		var seq uint64 = 1
		if n := len(q.segs); n > 0 {
			seq = q.segs[n-1].seq + 1
		}
		if seq <= q.lastSeq {
			seq = q.lastSeq + 1
		}
		path := filepath.Join(q.dir, fmt.Sprintf("%016d%s", seq, segmentSuffix))
		f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND|os.O_EXCL, 0o600)
		if err != nil {
			return err
		}
		salt := make([]byte, saltBytes)
		if _, err := rand.Read(salt); err != nil {
			f.Close()
			return err
		}
		if _, err := f.Write(salt); err != nil {
			f.Close()
			return err
		}
		q.active, q.activeIndex, q.lastSeq = f, 0, seq
		q.segs = append(q.segs, &segment{seq: seq, salt: salt, path: path, size: saltBytes})
		q.store.total.Add(saltBytes)
	}
	seg := q.segs[len(q.segs)-1]
	aead, err := q.aead(seg)
	if err != nil {
		return err
	}
	spooledAt := q.store.now()
	h := header(rec, spooledAt)
	sealed := aead.Seal(nil, nonce(q.activeIndex), rec.Frame, aad(q.slot, h))
	total := len(h) + len(sealed)
	if total > maxRecordBytes {
		return errors.New("a record is larger than the spool takes")
	}
	buf := make([]byte, 6, 6+total)
	binary.BigEndian.PutUint32(buf[0:], uint32(total))
	binary.BigEndian.PutUint16(buf[4:], uint16(len(h)))
	buf = append(append(buf, h...), sealed...)
	if _, err := q.active.Write(buf); err != nil {
		return err
	}
	q.activeIndex++
	seg.size += int64(len(buf))
	if seg.records == 0 {
		seg.firstOrder = rec.Order
	}
	seg.records++
	seg.lastOrder = rec.Order
	seg.lastSpooled = spooledAt
	if rec.Final {
		seg.finalOrder, seg.finalPos = rec.Order, rec.Position
	}
	q.store.total.Add(int64(len(buf)))
	q.dirty = true
	q.wake()
	return nil
}

// sync makes appended records durable; the newest final record durable so far is noted.
func (q *Queue) sync() error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.active == nil || !q.dirty {
		return nil
	}
	if err := q.active.Sync(); err != nil {
		return err
	}
	q.dirty = false
	for i := len(q.segs) - 1; i >= 0; i-- {
		if q.segs[i].finalOrder > 0 {
			q.syncedOrder, q.syncedPos = q.segs[i].finalOrder, q.segs[i].finalPos
			break
		}
	}
	return nil
}

// Synced is the newest final record made durable: what the source may let go of in need.
func (q *Queue) Synced() (uint64, string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.syncedOrder, q.syncedPos
}

// LastFinal is the newest final record spooled: where a reader resumes so as not to read it twice.
func (q *Queue) LastFinal() (uint64, string) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for i := len(q.segs) - 1; i >= 0; i-- {
		if q.segs[i].finalOrder > 0 {
			return q.segs[i].finalOrder, q.segs[i].finalPos
		}
	}
	return 0, ""
}

// Pending says whether anything waits for the cell: records not acknowledged, or gaps.
func (q *Queue) Pending() bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.gaps) > 0 || (len(q.segs) > 0 && q.segs[len(q.segs)-1].lastOrder > q.acked)
}

// Ack records that the cell holds everything up to order; segments wholly behind it go.
func (q *Queue) Ack(order uint64) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if order <= q.acked {
		return
	}
	q.acked = order
	defer q.wake()
	keep := q.segs[:0]
	for i, seg := range q.segs {
		if seg.lastOrder <= order {
			if i == len(q.segs)-1 {
				q.closeActive()
			}
			_ = os.Remove(seg.path)
			q.store.total.Add(-seg.size)
			continue
		}
		keep = append(keep, seg)
	}
	q.segs = keep
}

// Received records that the cell has every record up to and including id; segments wholly
// behind it go.
func (q *Queue) Received(id string) {
	seq, index, ok := ParseID(id)
	if !ok {
		return
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.received && (seq < q.receivedSeq || (seq == q.receivedSeq && index <= q.receivedIndex)) {
		return
	}
	q.receivedSeq, q.receivedIndex, q.received = seq, index, true
	keep := q.segs[:0]
	for i, seg := range q.segs {
		whole := seg.seq < seq || (seg.seq == seq && index+1 >= uint64(seg.records))
		if whole {
			if i == len(q.segs)-1 {
				q.closeActive()
			}
			_ = os.Remove(seg.path)
			q.store.total.Add(-seg.size)
			continue
		}
		keep = append(keep, seg)
	}
	q.segs = keep
	q.wake()
}

func (q *Queue) receivedPast(seq, index uint64) bool {
	return q.received && (seq < q.receivedSeq || (seq == q.receivedSeq && index <= q.receivedIndex))
}

// Acked is the latest order the cell acknowledged here.
func (q *Queue) Acked() uint64 {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.acked
}

// SourceConfirmed records that the source was told it may let go of what is spooled up to
// order, before the cell had it: the spool then holds the only copy, so it is kept.
func (q *Queue) SourceConfirmed(order uint64) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if order <= q.sourceConfirmed {
		return nil
	}
	q.sourceConfirmed = order
	raw, _ := json.Marshal(meta{SourceConfirmed: order})
	return writeFile(filepath.Join(q.dir, metaFile), raw)
}

// Precious says whether the spool holds records the source no longer has.
func (q *Queue) Precious() bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.segs) > 0 && q.segs[0].firstOrder <= q.sourceConfirmed && q.sourceConfirmed > q.acked
}

// Gaps are the gap records the cell does not have yet.
func (q *Queue) Gaps() []Gap {
	q.mu.Lock()
	defer q.mu.Unlock()
	return append([]Gap(nil), q.gaps...)
}

// AddGap records a gap, such as a resumed reader finding the source past the acknowledged position.
func (q *Queue) AddGap(g Gap) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.addGapLocked(g)
}

func (q *Queue) addGapLocked(g Gap) error {
	if g.ID == "" {
		g.ID = newID()
	}
	q.gaps = append(q.gaps, g)
	q.wake()
	return q.saveGaps()
}

// AckGap drops a gap record the cell has.
func (q *Queue) AckGap(id string) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	keep := q.gaps[:0]
	for _, g := range q.gaps {
		if g.ID != id {
			keep = append(keep, g)
		}
	}
	q.gaps = keep
	return q.saveGaps()
}

func (q *Queue) saveGaps() error {
	raw, _ := json.Marshal(q.gaps)
	return writeFile(filepath.Join(q.dir, gapsFile), raw)
}

// dropOldest removes the queue's oldest segment for the bound, recording what it held
// unacknowledged as a gap. False when there is nothing to drop.
func (q *Queue) dropOldest(reason string) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.segs) == 0 {
		return false
	}
	seg := q.segs[0]
	if len(q.segs) == 1 {
		q.closeActive()
	}
	gap := Gap{Reason: reason}
	if seg.lastOrder > q.acked {
		if f, err := os.Open(seg.path); err == nil {
			if aead, err := q.aead(seg); err == nil && seekPast(f) == nil {
				r := bufio.NewReader(f)
				for index := uint64(0); ; index++ {
					rec, _, err := readRecord(r, aead, q.slot, index)
					if err != nil {
						break
					}
					if rec.Order <= q.acked {
						continue
					}
					gap.Records++
					gap.Changes += rec.Changes
					if gap.From.IsZero() || rec.CommittedAt.Before(gap.From) {
						gap.From = rec.CommittedAt
					}
					if rec.CommittedAt.After(gap.To) {
						gap.To = rec.CommittedAt
					}
				}
			}
			f.Close()
		}
	}
	_ = os.Remove(seg.path)
	q.store.total.Add(-seg.size)
	q.segs = q.segs[1:]
	if gap.Records > 0 {
		_ = q.addGapLocked(gap)
	}
	return true
}

// Cursor reads the queue's records in order, from the first the cell has not acknowledged.
type Cursor struct {
	q     *Queue
	seq   uint64
	index uint64
	off   int64
}

// Cursor starts at the oldest record still held.
func (q *Queue) Cursor() *Cursor { return &Cursor{q: q} }

// Next is the next record not yet acknowledged, waiting for one until ctx ends. A segment
// dropped under the cursor is skipped: its gap record says what it held.
func (c *Cursor) Next(ctx interface{ Done() <-chan struct{} }) (Record, error) {
	for {
		q := c.q
		q.mu.Lock()
		if q.removed {
			q.mu.Unlock()
			return Record{}, ErrClosed
		}
		var seg *segment
		for _, s := range q.segs {
			if s.seq >= c.seq {
				seg = s
				break
			}
		}
		if seg == nil {
			wait := q.notify
			q.mu.Unlock()
			select {
			case <-ctx.Done():
				return Record{}, io.EOF
			case <-wait:
				continue
			}
		}
		if seg.seq != c.seq || c.off == 0 {
			c.seq, c.index, c.off = seg.seq, 0, saltBytes
		}
		last := seg == q.segs[len(q.segs)-1]
		size, acked, wait := seg.size, q.acked, q.notify
		seq, index := c.seq, c.index
		past := q.receivedPast(seq, index)
		q.mu.Unlock()
		if c.off >= size {
			if !last {
				c.seq++
				c.index, c.off = 0, 0
				continue
			}
			select {
			case <-ctx.Done():
				return Record{}, io.EOF
			case <-wait:
				continue
			}
		}
		rec, n, err := c.read(seg, size)
		if err != nil {
			return Record{}, err
		}
		c.off += n
		c.index++
		if rec.Order <= acked || past {
			continue
		}
		rec.ID = strconv.FormatUint(seq, 10) + "." + strconv.FormatUint(index, 10)
		return rec, nil
	}
}

func (c *Cursor) read(seg *segment, size int64) (Record, int64, error) {
	f, err := os.Open(seg.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			// Dropped or acknowledged meanwhile: on to the next.
			return Record{Order: 0}, size - c.off, nil
		}
		return Record{}, 0, err
	}
	defer f.Close()
	if _, err := f.Seek(c.off, io.SeekStart); err != nil {
		return Record{}, 0, err
	}
	aead, err := c.q.aead(seg)
	if err != nil {
		return Record{}, 0, err
	}
	return readRecord(io.LimitReader(f, size-c.off), aead, c.q.slot, c.index)
}

func seekPast(f *os.File) error {
	_, err := f.Seek(saltBytes, io.SeekStart)
	return err
}

func newID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

func writeFile(path string, raw []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
