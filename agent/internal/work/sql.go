// Package work runs the cell's work on this host (spec 10.4). A read is a generated,
// parameterised statement run in a read-only transaction, its rows sent back in frames,
// stopping at the row bound. A failure is reported by category and the source's SQLSTATE,
// never its message text.
//
// Each database speaks its own dialect (the cell generates the statements for it): Postgres
// (postgres.go), MySQL (mysql.go), SQL Server (sqlserver.go) and Oracle (oracle.go). A dialect gives sessions: one call's connection, on a login
// this agent holds or on the cell's.
//
// The login (spec 10.7) is the cell's by default: it arrives sealed to this agent for this one
// piece of work (package login), opens only here, reaches only a target the host's owner allows,
// and is used for one connection, closed and wiped when the call ends. Or the agent holds it
// (agent-held): a DSN in its configuration, with a small pool per connection.
//
// A write (sql.transaction) runs only on a signed execution grant from the cell's actions,
// checked here (package grant, spec 10.4): unsigned, mismatched, expired or replayed, it is
// refused with the reason, and nothing runs. A granted write runs its statements in one
// read-write transaction; a statement that changes a different number of rows than expected
// rolls it all back, and so does any failure.
package work

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/netip"
	"time"

	"silohq.io/agent/internal/grant"
	"silohq.io/agent/internal/login"
	"silohq.io/agent/internal/protocol"
)

// DSNs finds a connection's DSN in the agent's configuration.
type DSNs func(connectionID string) (dsn string, known bool, err error)

// Emit sends one result frame up the work stream.
type Emit = func(frame any) error

// session is one call's use of a database.
type session interface {
	// read runs text read-only, giving each row to row until it answers false.
	read(ctx context.Context, text string, args []any, row func(map[string]any) bool) error
	// write runs the statements in one transaction and commits only if each changed the rows it
	// expects: their row counts, or a mismatch, or the error.
	write(ctx context.Context, statements []writeStatement) ([]int, error)
	// close ends the call: back to its pool, or closed.
	close()
}

// dialect is one kind of database.
type dialect interface {
	// held is a session on a login this agent holds: the connection's DSN, pooled.
	held(ctx context.Context, connectionID, dsn string) (session, error)
	// sealed is a session on the cell's login for one call, at the addresses allowed (nil: by name).
	sealed(ctx context.Context, l *login.Login, addrs []string) (session, error)
	// failure is the frame for an error of this database.
	failure(ctx context.Context, err error) protocol.Error
	close()
}

// mismatch: a statement changed other than it expected; nothing was committed.
type mismatch struct{ index, rows int }

func (m *mismatch) Error() string { return "a statement changed other than it expected" }

var (
	errUnknownConnection = errors.New("this agent holds no login for the connection")
	errUnreachable       = errors.New("the source is unreachable")
)

// SQL runs reads and granted writes in every dialect this agent speaks.
type SQL struct {
	dsns     DSNs
	grants   *grant.Verifier
	dialects map[string]dialect
	// Logins the cell keeps (spec 10.7): opened with this agent's keys, to the targets allowed.
	logins  *login.Opener
	targets login.Targets
	// Resolve finds a target's addresses (tests replace it).
	Resolve func(context.Context, string) ([]netip.Addr, error)
}

// NewSQL runs reads, and writes on grants grants verifies; logins the cell seals open with
// logins, for the targets allowed.
func NewSQL(dsns DSNs, grants *grant.Verifier, logins *login.Opener, targets login.Targets) *SQL {
	return &SQL{dsns: dsns, grants: grants, logins: logins, targets: targets, dialects: map[string]dialect{
		"postgres":  newPostgres(),
		"mysql":     newMySQL(),
		"sqlserver": newSQLServer(),
		"oracle":    newOracle(),
	}}
}

// Close closes every pool.
func (s *SQL) Close() {
	for _, d := range s.dialects {
		d.close()
	}
}

// open is the call's session: on the cell's sealed login, or on the login this agent holds. A
// refusal of the sealed login is its reason.
func (s *SQL) open(ctx context.Context, d dialect, connectionID string, sealed *protocol.SealedLogin) (sess session, release func(), refusal string, err error) {
	if sealed == nil {
		dsn, known, err := s.dsns(connectionID)
		if !known {
			return nil, nil, "", errUnknownConnection
		}
		if err != nil {
			return nil, nil, "", err
		}
		sess, err := d.held(ctx, connectionID, dsn)
		if err != nil {
			return nil, nil, "", err
		}
		return sess, sess.close, "", nil
	}
	if s.logins == nil {
		return nil, nil, login.RefusedNoKey, nil
	}
	l, reason := s.logins.Open(sealed, connectionID, protocol.WorkID(ctx), time.Now())
	if reason != "" {
		return nil, nil, reason, nil
	}
	// A database login names its host and its database.
	if l.Host == "" || l.Database == "" {
		l.Zero()
		return nil, nil, login.RefusedSealing, nil
	}
	addrs, allowed := s.targets.Allow(ctx, l.Host, s.Resolve)
	if !allowed {
		l.Zero()
		return nil, nil, login.RefusedTarget, nil
	}
	sess, err = d.sealed(ctx, l, addrs)
	if err != nil {
		l.Zero()
		return nil, nil, "", err
	}
	return sess, func() {
		sess.close()
		l.Zero()
	}, "", nil
}

func refused(reason string) protocol.Error {
	return protocol.Error{Type: "error", Category: protocol.LoginRefused, Reason: reason}
}

// Read runs a sql.read and emits its rows, then done; or one error frame.
func (s *SQL) Read(ctx context.Context, payload json.RawMessage, emit Emit) error {
	var read protocol.SQLRead
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	if err := decoder.Decode(&read); err != nil {
		return emit(protocol.NewError(protocol.Integrity, ""))
	}
	for i, value := range read.Statement.Values {
		read.Statement.Values[i] = boundValue(value)
	}
	d, ok := s.dialects[read.Dialect]
	if !ok {
		return emit(protocol.NewError(protocol.SourceUnreachable, ""))
	}
	sess, release, refusal, err := s.open(ctx, d, read.ConnectionID, read.Credential)
	if refusal != "" {
		return emit(refused(refusal))
	}
	if err != nil {
		return emit(d.failure(ctx, err))
	}
	defer release()
	batch := make([]map[string]any, 0, protocol.RowsPerFrame)
	count, truncated := 0, false
	var sent error
	err = sess.read(ctx, read.Statement.Text, read.Statement.Values, func(row map[string]any) bool {
		if read.MaxRows > 0 && count >= read.MaxRows {
			truncated = true
			return false
		}
		batch = append(batch, row)
		count++
		if len(batch) == protocol.RowsPerFrame {
			if sent = emit(protocol.NewRows(batch)); sent != nil {
				return false
			}
			batch = make([]map[string]any, 0, protocol.RowsPerFrame)
		}
		return true
	})
	if sent != nil {
		return sent
	}
	if err != nil {
		return emit(d.failure(ctx, err))
	}
	if len(batch) > 0 {
		if err := emit(protocol.NewRows(batch)); err != nil {
			return err
		}
	}
	return emit(protocol.NewDone(count, truncated))
}

// sqlTransaction is a write's payload; Statements stays as it arrived, for the grant's hash.
type sqlTransaction struct {
	ConnectionID string                `json:"connectionId"`
	Dialect      string                `json:"dialect"`
	Statements   json.RawMessage       `json:"statements"`
	Grant        *grant.Signed         `json:"grant"`
	Credential   *protocol.SealedLogin `json:"credential"`
}

type writeStatement struct {
	Text       string `json:"text"`
	Values     []any  `json:"values"`
	ExpectRows *int   `json:"expectRows"`
}

// Transaction runs a granted write in one transaction, emitting done with each statement's row
// count; or one error frame, and nothing applied.
func (s *SQL) Transaction(ctx context.Context, payload json.RawMessage, emit Emit) error {
	var work sqlTransaction
	if err := json.Unmarshal(payload, &work); err != nil {
		return emit(protocol.NewError(protocol.Integrity, ""))
	}
	var statements []writeStatement
	decoder := json.NewDecoder(bytes.NewReader(work.Statements))
	decoder.UseNumber()
	if err := decoder.Decode(&statements); err != nil || len(statements) == 0 {
		return emit(protocol.NewError(protocol.Integrity, ""))
	}
	if s.grants == nil {
		return emit(protocol.Error{Type: "error", Category: protocol.GrantRefused, Reason: "unsigned"})
	}
	if _, reason := s.grants.Check(work.Grant, work.ConnectionID, work.Statements, len(statements)); reason != "" {
		return emit(protocol.Error{Type: "error", Category: protocol.GrantRefused, Reason: reason})
	}
	d, ok := s.dialects[work.Dialect]
	if !ok {
		return emit(protocol.NewError(protocol.SourceUnreachable, ""))
	}
	for i := range statements {
		for j, value := range statements[i].Values {
			statements[i].Values[j] = boundValue(value)
		}
	}
	sess, release, refusal, err := s.open(ctx, d, work.ConnectionID, work.Credential)
	if refusal != "" {
		return emit(refused(refusal))
	}
	if err != nil {
		return emit(d.failure(ctx, err))
	}
	defer release()
	counts, err := sess.write(ctx, statements)
	var m *mismatch
	if errors.As(err, &m) {
		return emit(protocol.Error{Type: "error", Category: protocol.RowCountMismatch, Index: &m.index, Rows: &m.rows})
	}
	if err != nil {
		return emit(d.failure(ctx, err))
	}
	total := 0
	for _, n := range counts {
		total += n
	}
	done := protocol.NewDone(total, false)
	done.RowCounts = counts
	return emit(done)
}

// boundValue is a statement value as the driver binds it: a whole number as an integer, any
// other number as a double, everything else as JSON gave it.
func boundValue(v any) any {
	n, ok := v.(json.Number)
	if !ok {
		return v
	}
	if i, err := n.Int64(); err == nil {
		return i
	}
	if f, err := n.Float64(); err == nil {
		return f
	}
	return string(n)
}

// unreachableOr is the frame for an error no database classified: a timeout, or unreachable.
func unreachableOr(ctx context.Context, err error) protocol.Error {
	if errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil {
		return protocol.NewError(protocol.Timeout, "")
	}
	return protocol.NewError(protocol.SourceUnreachable, "")
}
