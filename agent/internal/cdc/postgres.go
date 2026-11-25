// Package cdc reads changes from customer databases in their own logs (spec 10.4: "Local CDC
// readers ... Emits normalised changes with log positions. Uses a customer-supplied read-only
// replication user"). Postgres first: logical replication through the pgoutput plugin, from
// a publication the customer made.
//
//   - The slot is made on first start if missing, and replication resumes from the position
//     the cell last acknowledged (spec 10.3: "another agent resumes from the last acknowledged
//     position on lease loss"). Changes go up in batches, one per committed transaction, each
//     with the position just after it.
//   - Postgres is told a position is flushed only once the cell has acknowledged it, so nothing
//     is lost if the agent or the tunnel fails: the next reader starts there and the cell drops
//     what it has seen (at least once, deduplicated in change-stream).
//   - Values are decoded by the column's type as reads decode them (package values). A TOASTed
//     value the update did not touch is not sent, so it is left out, never sent as null.
//   - A large transaction goes up in several batches (at most ChangesPerBatch changes or about
//     BytesPerBatch each), so neither the agent nor a frame holds it whole; only the last carries
//     the position to acknowledge. Each change carries its own place in the log, the commit's
//     LSN and its index in the transaction, as text that sorts in log order.
//   - Resuming from an acknowledged position never makes the slot again: a slot that is gone, or
//     that Postgres invalidated (max_slot_wal_keep_size), lost what it held, so Run returns
//     ErrLost and only a new capture starts over.
//   - Transactions with nothing published, and the server's idle keepalives, go up as a
//     position with no changes (at most one every ten seconds), so the cell's acknowledged position
//     keeps up and a quiet publication holds no log back.
//   - Postgres hears only what the cell acknowledged, except when its slot is about to be
//     invalidated (its safe WAL under a quarter of max_slot_wal_keep_size, or wal_status
//     unreserved): then it also hears what the agent has spooled durably (Confirmable), so the
//     slot survives a long outage, and the spool keeps that part as the only copy.
//   - Resuming from a position, a slot the source already holds past it means another agent's
//     spool had what lies between: Ahead is told, for a gap record.
package cdc

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"sync/atomic"
	"time"

	"github.com/jackc/pglogrepl"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgproto3"
	"github.com/jackc/pgx/v5/pgtype"

	"silohq.io/agent/internal/values"
)

// ErrLost is a slot gone or invalidated on the source: what it held is lost.
var ErrLost = errors.New("the replication slot is gone or invalidated")

// ErrFull is what Emit says when the spool has no room: the reader waits, keeping its slot, and
// tries again (spec 9.4: "CDC readers slow and spool").
var ErrFull = errors.New("no room to spool changes")

// Change is one row's change, normalised.
type Change struct {
	Op     string `json:"op"`
	Schema string `json:"schema"`
	Table  string `json:"table"`
	// Position is the change's place in the log: the commit's LSN and its index, sorting as text.
	Position string         `json:"position"`
	Values   map[string]any `json:"values"`
}

// Batch is a committed transaction's changes, or part of them; Position, on the last part
// only, is what to acknowledge. A position with no changes moves it past what holds nothing
// published.
type Batch struct {
	Type        string    `json:"type"`
	Position    string    `json:"position,omitempty"`
	CommittedAt time.Time `json:"committedAt"`
	Changes     []Change  `json:"changes"`
	// Order sorts batches in log order: the commit's LSN, its end on the last part.
	Order uint64 `json:"-"`
}

// Order is a position's place in the log, for comparing positions.
func Order(position string) (uint64, error) {
	lsn, err := pglogrepl.ParseLSN(position)
	return uint64(lsn), err
}

// MarkerEvery bounds how often a position with no changes goes up.
const MarkerEvery = 10 * time.Second

// RiskEvery is how often the slot's standing is checked.
const RiskEvery = time.Minute

const (
	// ChangesPerBatch and BytesPerBatch bound one batch, within the cell's frame bound.
	ChangesPerBatch = 500
	BytesPerBatch   = 1 << 20
)

// changePosition sorts as text in log order: 16 hex digits of the commit LSN, then the index.
func changePosition(commit pglogrepl.LSN, index int) string {
	return fmt.Sprintf("%016X/%08d", uint64(commit), index)
}

// Postgres is one reader on one slot.
type Postgres struct {
	DSN         string
	SlotName    string
	Publication string
	// Start is the last acknowledged position, or empty for where the slot stands.
	Start  string
	Emit   func(Batch) error
	Logger *slog.Logger
	// StatusEvery is how often Postgres hears the acknowledged position (10 s).
	StatusEvery time.Duration
	// Started is told once the slot streams.
	Started func() error
	// Confirmable is the newest position spooled durably, which Postgres may hear when its slot is at risk.
	Confirmable func() uint64
	// SourceConfirmed is told when Postgres heard a position the cell had not acknowledged.
	SourceConfirmed func(order uint64)
	// Ahead is told when the slot already stands past Start.
	Ahead func(from, to string)

	acked     atomic.Uint64
	atRisk    atomic.Bool
	confirmed uint64
}

// Ack records a position the cell has acknowledged; Postgres hears it at the next status.
func (p *Postgres) Ack(position string) error {
	lsn, err := pglogrepl.ParseLSN(position)
	if err != nil {
		return err
	}
	p.advance(lsn)
	return nil
}

func (p *Postgres) advance(lsn pglogrepl.LSN) {
	for {
		current := p.acked.Load()
		if uint64(lsn) <= current || p.acked.CompareAndSwap(current, uint64(lsn)) {
			return
		}
	}
}

// AtRiskNow says whether the slot was last found about to be invalidated.
func (p *Postgres) AtRiskNow() bool { return p.atRisk.Load() }

// AtRisk says whether the slot is about to be invalidated: what decides it, for tests and logs.
func AtRisk(walStatus string, safeWALSize, maxKeepSize *int64) bool {
	if walStatus == "unreserved" || walStatus == "lost" {
		return true
	}
	return safeWALSize != nil && maxKeepSize != nil && *maxKeepSize > 0 && *safeWALSize < *maxKeepSize/4
}

// watchRisk checks the slot's standing every RiskEvery on a connection of its own.
func (p *Postgres) watchRisk(ctx context.Context) {
	check := func() {
		cctx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		conn, err := pgx.Connect(cctx, p.DSN)
		if err != nil {
			return
		}
		defer conn.Close(context.Background())
		var status *string
		var safe, keep *int64
		err = conn.QueryRow(cctx, `select wal_status, safe_wal_size, pg_size_bytes(current_setting('max_slot_wal_keep_size'))
			from pg_replication_slots where slot_name = $1`, p.SlotName).Scan(&status, &safe, &keep)
		if err != nil {
			return
		}
		risk := AtRisk(deref(status), safe, keep)
		if risk != p.atRisk.Swap(risk) {
			p.Logger.Warn("the replication slot's standing changed", "event", "agent.cdc_slot_risk", "slot", p.SlotName, "at_risk", risk)
		}
	}
	ticker := time.NewTicker(RiskEvery)
	defer ticker.Stop()
	for {
		check()
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// position is what Postgres hears: the acknowledged position, or more when the slot is at risk.
func (p *Postgres) position() pglogrepl.LSN {
	acked := p.acked.Load()
	if p.atRisk.Load() && p.Confirmable != nil {
		if spooled := p.Confirmable(); spooled > acked {
			if spooled > p.confirmed && p.SourceConfirmed != nil {
				p.SourceConfirmed(spooled)
			}
			p.confirmed = max(p.confirmed, spooled)
			return pglogrepl.LSN(spooled)
		}
	}
	return pglogrepl.LSN(acked)
}

func replicationDSN(dsn string) (string, error) {
	u, err := url.Parse(dsn)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		return "", errors.New("the replication DSN is a postgres:// URL")
	}
	q := u.Query()
	q.Set("replication", "database")
	u.RawQuery = q.Encode()
	return u.String(), nil
}

var identifier = func(s string) bool {
	if s == "" || len(s) > 63 {
		return false
	}
	for _, r := range s {
		if !(r == '_' || (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9')) {
			return false
		}
	}
	return true
}

// Run reads until ctx ends or the source fails.
func (p *Postgres) Run(ctx context.Context) error {
	if !identifier(p.SlotName) || !identifier(p.Publication) {
		return errors.New("a slot or publication name is lower-case letters, digits and underscores")
	}
	if p.StatusEvery == 0 {
		p.StatusEvery = 10 * time.Second
	}
	dsn, err := replicationDSN(p.DSN)
	if err != nil {
		return err
	}
	conn, err := pgconn.Connect(ctx, dsn)
	if err != nil {
		return fmt.Errorf("cannot connect for replication: %w", err)
	}
	defer conn.Close(context.Background())

	var start pglogrepl.LSN
	if p.Start == "" {
		// Never read: the slot is made here, or found where an earlier reader made it.
		created, err := pglogrepl.CreateReplicationSlot(ctx, conn, p.SlotName, "pgoutput", pglogrepl.CreateReplicationSlotOptions{Mode: pglogrepl.LogicalReplication})
		switch {
		case err == nil:
			start, _ = pglogrepl.ParseLSN(created.ConsistentPoint)
		case isDuplicate(err):
			// Where the slot stands.
		default:
			return fmt.Errorf("cannot make the replication slot: %w", err)
		}
	} else if start, err = pglogrepl.ParseLSN(p.Start); err != nil {
		return err
	} else if p.Ahead != nil {
		// The slot standing past where the cell has everything: another agent's spool had what lies between.
		results, err := conn.Exec(ctx, fmt.Sprintf("select confirmed_flush_lsn::text from pg_replication_slots where slot_name = '%s'", p.SlotName)).ReadAll()
		if err == nil && len(results) == 1 && len(results[0].Rows) == 1 && len(results[0].Rows[0]) == 1 && results[0].Rows[0][0] != nil {
			if flushed, err := pglogrepl.ParseLSN(string(results[0].Rows[0][0])); err == nil && flushed > start {
				p.Ahead(start.String(), flushed.String())
			}
		}
	}
	p.acked.Store(uint64(start))
	go p.watchRisk(ctx)
	if err := pglogrepl.StartReplication(ctx, conn, p.SlotName, start, pglogrepl.StartReplicationOptions{
		Mode: pglogrepl.LogicalReplication, PluginArgs: []string{"proto_version '1'", fmt.Sprintf("publication_names '%s'", p.Publication)},
	}); err != nil {
		var pgErr *pgconn.PgError
		// 42704: no such slot; 55000: invalidated, it can no longer give changes.
		if errors.As(err, &pgErr) && (pgErr.Code == "42704" || pgErr.Code == "55000") {
			return ErrLost
		}
		return fmt.Errorf("cannot start replication: %w", err)
	}
	p.Logger.Info("change capture started", "event", "agent.cdc_started", "slot", p.SlotName)
	if p.Started != nil {
		if err := p.Started(); err != nil {
			return fmt.Errorf("cannot report the capture started: %w", err)
		}
	}

	relations := map[uint32]*pglogrepl.RelationMessage{}
	types := pgtype.NewMap()
	var (
		pending    []Change
		size       int
		commitLSN  pglogrepl.LSN
		commitTime time.Time
		index      int
		parted     bool
		inside     bool
	)
	status := time.Now().Add(p.StatusEvery)
	report := func() error {
		heard := p.position()
		// What the cell acknowledged is written, flushed and applied, so a failure replays from there.
		if err := pglogrepl.SendStandbyStatusUpdate(ctx, conn, pglogrepl.StandbyStatusUpdate{
			WALWritePosition: heard, WALFlushPosition: heard, WALApplyPosition: heard,
		}); err != nil {
			return fmt.Errorf("cannot report the position: %w", err)
		}
		status = time.Now().Add(p.StatusEvery)
		return nil
	}
	emit := func(batch Batch) error {
		if batch.Changes == nil {
			// The last part of a transaction that ended on a part's bound: no changes, never null.
			batch.Changes = []Change{}
		}
		paused := false
		for {
			err := p.Emit(batch)
			if err == nil {
				if paused {
					p.Logger.Info("room in the spool again: reading on", "event", "agent.cdc_resumed", "slot", p.SlotName)
				}
				return nil
			}
			if !errors.Is(err, ErrFull) {
				return fmt.Errorf("cannot spool changes: %w", err)
			}
			// No room: the source keeps what is not read yet; the slot is kept alive meanwhile.
			if !paused {
				p.Logger.Warn("the spool is full: reading waits for the cell", "event", "agent.cdc_paused", "slot", p.SlotName)
				paused = true
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(250 * time.Millisecond):
			}
			if time.Now().After(status) {
				if err := report(); err != nil {
					return err
				}
			}
		}
	}
	// A position past what holds nothing published, at most one a second.
	var lastOrder pglogrepl.LSN = start
	var lastMarker time.Time
	marker := func(lsn pglogrepl.LSN, at time.Time) error {
		if lsn <= lastOrder || time.Since(lastMarker) < MarkerEvery {
			return nil
		}
		lastOrder, lastMarker = lsn, time.Now()
		return emit(Batch{Type: "changes", Position: lsn.String(), CommittedAt: at, Changes: []Change{}, Order: uint64(lsn)})
	}
	add := func(op string, rel *pglogrepl.RelationMessage, tuple *pglogrepl.TupleData) error {
		change, bytes, ok := toChange(op, rel, tuple, types)
		if !ok {
			return nil
		}
		change.Position = changePosition(commitLSN, index)
		index++
		pending = append(pending, change)
		size += bytes
		if len(pending) >= ChangesPerBatch || size >= BytesPerBatch {
			if err := emit(Batch{Type: "changes", CommittedAt: commitTime, Changes: pending, Order: uint64(commitLSN)}); err != nil {
				return err
			}
			pending, size, parted = nil, 0, true
		}
		return nil
	}
	for {
		if time.Now().After(status) {
			if err := report(); err != nil {
				return err
			}
		}
		rctx, cancel := context.WithDeadline(ctx, status)
		raw, err := conn.ReceiveMessage(rctx)
		cancel()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			if pgconn.Timeout(err) {
				continue
			}
			return fmt.Errorf("replication broke off: %w", err)
		}
		if failure, ok := raw.(*pgproto3.ErrorResponse); ok {
			return fmt.Errorf("the source refused replication (%s)", failure.Code)
		}
		data, ok := raw.(*pgproto3.CopyData)
		if !ok || len(data.Data) == 0 {
			continue
		}
		switch data.Data[0] {
		case pglogrepl.PrimaryKeepaliveMessageByteID:
			keepalive, err := pglogrepl.ParsePrimaryKeepaliveMessage(data.Data[1:])
			if err == nil && !inside {
				if err := marker(keepalive.ServerWALEnd, time.Now().UTC()); err != nil {
					return err
				}
			}
			if err == nil && keepalive.ReplyRequested {
				status = time.Time{}
			}
		case pglogrepl.XLogDataByteID:
			xld, err := pglogrepl.ParseXLogData(data.Data[1:])
			if err != nil {
				return err
			}
			message, err := pglogrepl.Parse(xld.WALData)
			if err != nil {
				return fmt.Errorf("a log message does not parse: %w", err)
			}
			p.Logger.Debug("log message", "type", message.Type().String())
			var failed error
			switch m := message.(type) {
			case *pglogrepl.RelationMessage:
				relations[m.RelationID] = m
			case *pglogrepl.BeginMessage:
				pending, size, index, parted, inside = nil, 0, 0, false, true
				commitLSN, commitTime = m.FinalLSN, m.CommitTime.UTC()
			case *pglogrepl.InsertMessage:
				failed = add("insert", relations[m.RelationID], m.Tuple)
			case *pglogrepl.UpdateMessage:
				failed = add("update", relations[m.RelationID], m.NewTuple)
			case *pglogrepl.DeleteMessage:
				failed = add("delete", relations[m.RelationID], m.OldTuple)
			case *pglogrepl.CommitMessage:
				inside = false
				if len(pending) > 0 || parted {
					failed = emit(Batch{Type: "changes", Position: m.TransactionEndLSN.String(), CommittedAt: commitTime, Changes: pending,
						Order: uint64(m.TransactionEndLSN)})
					pending, size = nil, 0
					lastOrder = m.TransactionEndLSN
				} else {
					failed = marker(m.TransactionEndLSN, commitTime)
				}
			}
			if failed != nil {
				return failed
			}
		}
	}
}

// toChange is one row's change, and roughly how many bytes it carries.
func toChange(op string, rel *pglogrepl.RelationMessage, tuple *pglogrepl.TupleData, types *pgtype.Map) (Change, int, bool) {
	if rel == nil || tuple == nil {
		return Change{}, 0, false
	}
	row := make(map[string]any, len(tuple.Columns))
	bytes := 64
	for i, col := range tuple.Columns {
		if i >= len(rel.Columns) {
			break
		}
		name := rel.Columns[i].Name
		switch col.DataType {
		case pglogrepl.TupleDataTypeNull:
			row[name] = nil
		case pglogrepl.TupleDataTypeToast:
			// Unchanged and not sent: left out.
		case pglogrepl.TupleDataTypeText:
			row[name] = decode(types, rel.Columns[i].DataType, col.Data)
			bytes += len(name) + len(col.Data)
		}
	}
	return Change{Op: op, Schema: rel.Namespace, Table: rel.RelationName, Values: row}, bytes, true
}

// DropSlot drops a slot on the source, waiting for its reader to let it go; a slot already gone is dropped.
func DropSlot(ctx context.Context, dsn, slotName string) error {
	if !identifier(slotName) {
		return errors.New("a slot name is lower-case letters, digits and underscores")
	}
	replication, err := replicationDSN(dsn)
	if err != nil {
		return err
	}
	conn, err := pgconn.Connect(ctx, replication)
	if err != nil {
		return fmt.Errorf("cannot connect for replication: %w", err)
	}
	defer conn.Close(context.Background())
	err = pglogrepl.DropReplicationSlot(ctx, conn, slotName, pglogrepl.DropReplicationSlotOptions{Wait: true})
	var pgErr *pgconn.PgError
	if err != nil && errors.As(err, &pgErr) && pgErr.Code == "42704" {
		return nil
	}
	return err
}

// Failure is a reader's failure by kind, and the source's SQLSTATE where it gave one, never its text.
func Failure(err error) (category, sqlstate string) {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return "source_refused", pgErr.Code
	}
	var connectErr *pgconn.ConnectError
	if errors.As(err, &connectErr) || pgconn.Timeout(err) {
		return "source_unreachable", ""
	}
	return "internal", ""
}

func decode(types *pgtype.Map, oid uint32, data []byte) any {
	if t, ok := types.TypeForOID(oid); ok {
		if v, err := t.Codec.DecodeValue(types, oid, pgtype.TextFormatCode, data); err == nil {
			return values.ForColumn(oid, v)
		}
	}
	return string(data)
}

func isDuplicate(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "42710" || strings.Contains(err.Error(), "already exists")
}
