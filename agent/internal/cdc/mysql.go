package cdc

import (
	"context"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"log/slog"
	"math"
	"net"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/go-mysql-org/go-mysql/client"
	"github.com/go-mysql-org/go-mysql/mysql"
	"github.com/go-mysql-org/go-mysql/replication"
	"github.com/jackc/pglogrepl"

	"silohq.io/agent/internal/values"
)

// MySQL reads one capture from a MySQL (8.0 or later) server's binary log, as a replica does
// (spec 10.4: binlog). The server keeps no slot for a reader: its binary logs are its own, kept
// for its own retention (binlog_expire_logs_seconds), so a reader resumes from the position the
// cell last acknowledged while the server still holds that log, and a log the server has let go
// is lost (ErrLost), as an invalidated Postgres slot is.
//
//   - The server must log rows, whole, with their metadata: binlog_format ROW, binlog_row_image
//     FULL, binlog_row_metadata FULL (MySQL 8.0.1 and later) and no partial JSON updates, so each
//     row names its columns, its table's key and its enumerations' labels. Otherwise the reader
//     refuses (ErrNotConfigured) and logs which setting.
//   - The reader registers as a replica under the capture's slot name, so the customer sees it in
//     SHOW REPLICAS, with a server id derived from the capture.
//   - The binary log carries every table of the server. Only the tables the capture reads
//     (Tables, from the connection's manifest) are taken; every other row stays on the host.
//   - Positions are the binary log's own: the file's number and the offset after an event, kept
//     as an LSN-like "file/offset" in hex, so they order and compare as Postgres's do. A change's
//     place is its transaction's start and its index there (the log is written in commit order).
//   - An insert and an update carry the row's columns (the update its new image); a delete
//     carries its key's columns only, as Postgres's does.
//   - Transactions with no captured table go up as a position with no changes, at most one every
//     ten seconds, so the cell's acknowledged position keeps up.
type MySQL struct {
	// DSN is the replication login: mysql://user:password@host:port?sslmode=...
	DSN string
	// SlotID names the reader to the server: its replica server id comes from it.
	SlotID string
	// SlotName is the name the owner confirmed: the replica's host as the server lists it.
	SlotName string
	// Tables are the (schema, table) pairs the capture reads.
	Tables [][2]string
	// Start is the last acknowledged position, or empty for where the log stands now.
	Start   string
	Emit    func(Batch) error
	Logger  *slog.Logger
	Started func() error
}

// ErrNotConfigured is a server that does not log what a capture needs.
var ErrNotConfigured = errors.New("the source's log is not configured for change capture")

// Ack is nothing to a MySQL server: it keeps its logs by its own retention.
func (m *MySQL) Ack(string) error { return nil }

// AtRiskNow is never: what the spool holds already left the server's log, and what it has not
// read waits there under the server's own retention.
func (m *MySQL) AtRiskNow() bool { return false }

// serverID is the replica id the reader takes: stable for the capture, clear of the small ids
// real replicas use.
func serverID(slotID string) uint32 {
	h := fnv.New32a()
	_, _ = h.Write([]byte(slotID))
	return 0x40000000 | (h.Sum32() & 0x3fffffff)
}

// login is the replication login's parts. Its sslmode is as libpq's: disable, prefer (the
// default: TLS where the server offers it, else plain), require, verify-full.
func (m *MySQL) login() (host string, port uint16, user, password string, tlsConfig *tls.Config, prefer bool, err error) {
	u, err := url.Parse(m.DSN)
	if err != nil || u.Scheme != "mysql" || u.User == nil {
		return "", 0, "", "", nil, false, errors.New("the replication login is not a mysql:// URL")
	}
	p := u.Port()
	if p == "" {
		p = "3306"
	}
	n, err := strconv.ParseUint(p, 10, 16)
	if err != nil {
		return "", 0, "", "", nil, false, errors.New("the replication login's port is not a port")
	}
	password, _ = u.User.Password()
	switch mode := u.Query().Get("sslmode"); mode {
	case "disable":
	case "verify-full":
		tlsConfig = &tls.Config{ServerName: u.Hostname(), MinVersion: tls.VersionTLS12}
	default:
		tlsConfig = &tls.Config{ServerName: u.Hostname(), MinVersion: tls.VersionTLS12, InsecureSkipVerify: true}
		prefer = mode == "" || mode == "prefer"
	}
	return u.Hostname(), uint16(n), u.User.Username(), password, tlsConfig, prefer, nil
}

// split is a position's binary log number and offset.
func split(position string) (seq, offset uint32, err error) {
	lsn, err := pglogrepl.ParseLSN(position)
	if err != nil {
		return 0, 0, err
	}
	return uint32(uint64(lsn) >> 32), uint32(uint64(lsn)), nil
}

func joined(seq, offset uint32) pglogrepl.LSN { return pglogrepl.LSN(uint64(seq)<<32 | uint64(offset)) }

// fileSeq is a binary log file's number: mysql-bin.000123 is 123.
func fileSeq(name string) (base string, seq uint32, ok bool) {
	dot := strings.LastIndexByte(name, '.')
	if dot < 0 {
		return "", 0, false
	}
	n, err := strconv.ParseUint(name[dot+1:], 10, 32)
	if err != nil {
		return "", 0, false
	}
	return name[:dot], uint32(n), true
}

// where checks the server logs what a capture needs, and says where its log stands and which
// files it still holds.
func (m *MySQL) where(ctx context.Context, host string, port uint16, user, password string, tlsConfig *tls.Config) (current string, offset uint32, held map[string]bool, err error) {
	dialer := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
	conn, err := client.ConnectWithDialer(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(int(port))), user, password, "", dialer.DialContext,
		func(c *client.Conn) error {
			if tlsConfig != nil {
				c.SetTLSConfig(tlsConfig)
			}
			return nil
		})
	if err != nil {
		return "", 0, nil, err
	}
	defer conn.Close()
	settings, err := conn.Execute("SELECT @@log_bin, @@binlog_format, @@binlog_row_image, @@binlog_row_metadata, @@binlog_row_value_options")
	if err != nil {
		return "", 0, nil, err
	}
	want := []string{"1", "ROW", "FULL", "FULL", ""}
	names := []string{"log_bin", "binlog_format", "binlog_row_image", "binlog_row_metadata", "binlog_row_value_options"}
	for i, w := range want {
		got, _ := settings.GetString(0, i)
		if !strings.EqualFold(got, w) {
			m.Logger.Warn("the source does not log what change capture needs", "event", "agent.cdc_not_configured", "setting", names[i], "needs", w)
			return "", 0, nil, ErrNotConfigured
		}
	}
	status, err := conn.Execute("SHOW BINARY LOG STATUS")
	if err != nil {
		// MySQL before 8.2 calls it the master's status.
		if status, err = conn.Execute("SHOW MASTER STATUS"); err != nil {
			return "", 0, nil, err
		}
	}
	if status.RowNumber() == 0 {
		return "", 0, nil, ErrNotConfigured
	}
	current, _ = status.GetString(0, 0)
	pos, _ := status.GetUint(0, 1)
	logs, err := conn.Execute("SHOW BINARY LOGS")
	if err != nil {
		return "", 0, nil, err
	}
	held = map[string]bool{}
	for i := 0; i < logs.RowNumber(); i++ {
		name, _ := logs.GetString(i, 0)
		held[name] = true
	}
	return current, uint32(pos), held, nil
}

func (m *MySQL) Run(ctx context.Context) error {
	host, port, user, password, tlsConfig, prefer, err := m.login()
	if err != nil {
		return err
	}
	current, offset, held, err := m.where(ctx, host, port, user, password, tlsConfig)
	if err != nil && prefer && strings.Contains(err.Error(), "does not support TLS") {
		// prefer: a server that offers no TLS is read plain.
		if current, offset, held, err = m.where(ctx, host, port, user, password, nil); err == nil {
			tlsConfig = nil
		}
	}
	if err != nil {
		return err
	}
	base, seq, ok := fileSeq(current)
	if !ok {
		return ErrNotConfigured
	}
	if m.Start != "" {
		if seq, offset, err = split(m.Start); err != nil {
			return err
		}
		if !held[fmt.Sprintf("%s.%06d", base, seq)] {
			// The server has let go of the log the cell has not taken yet.
			return ErrLost
		}
	}
	wanted := map[[2]string]bool{}
	for _, t := range m.Tables {
		wanted[t] = true
	}
	syncer := replication.NewBinlogSyncer(replication.BinlogSyncerConfig{
		ServerID: serverID(m.SlotID), Localhost: m.SlotName, Flavor: mysql.MySQLFlavor, Host: host, Port: port, User: user, Password: password,
		TLSConfig: tlsConfig, ParseTime: true, TimestampStringLocation: time.UTC, HeartbeatPeriod: 10 * time.Second,
		ReadTimeout: 30 * time.Second, MaxReconnectAttempts: 1,
		// The library's own log could name tables and positions; the agent logs what it chooses to.
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	defer syncer.Close()
	streamer, err := syncer.StartSync(mysql.Position{Name: fmt.Sprintf("%s.%06d", base, seq), Pos: offset})
	if err != nil {
		return fmt.Errorf("cannot start reading the binary log: %w", err)
	}
	m.Logger.Info("change capture started", "event", "agent.cdc_started", "method", "binlog")
	if m.Started != nil {
		if err := m.Started(); err != nil {
			return err
		}
	}

	var (
		pending    []Change
		size       int
		start      pglogrepl.LSN
		index      int
		parted     bool
		inside     bool
		lastOrder  = joined(seq, offset)
		lastMarker time.Time
	)
	emit := func(batch Batch) error { return spoolWaiting(ctx, m.Logger, m.Emit, batch) }
	marker := func(at pglogrepl.LSN, when time.Time) error {
		if at <= lastOrder || time.Since(lastMarker) < MarkerEvery {
			return nil
		}
		lastOrder, lastMarker = at, time.Now()
		return emit(Batch{Type: "changes", Position: at.String(), CommittedAt: when, Changes: []Change{}, Order: uint64(at)})
	}
	commit := func(at pglogrepl.LSN, when time.Time) error {
		inside = false
		if len(pending) > 0 || parted {
			if err := emit(Batch{Type: "changes", Position: at.String(), CommittedAt: when, Changes: pending, Order: uint64(at)}); err != nil {
				return err
			}
			pending, size, parted = nil, 0, false
			lastOrder = at
			return nil
		}
		return marker(at, when)
	}
	for {
		ev, err := streamer.GetEvent(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("the binary log broke off: %w", err)
		}
		at := joined(seq, ev.Header.LogPos)
		when := time.Unix(int64(ev.Header.Timestamp), 0).UTC()
		switch e := ev.Event.(type) {
		case *replication.RotateEvent:
			if _, next, ok := fileSeq(string(e.NextLogName)); ok {
				seq = next
			}
		case *replication.GTIDEvent:
			pending, size, index, parted, inside, start = nil, 0, 0, false, true, at
		case *replication.QueryEvent:
			switch {
			case strings.EqualFold(string(e.Query), "BEGIN") && !inside:
				pending, size, index, parted, inside, start = nil, 0, 0, false, true, at
			case strings.EqualFold(string(e.Query), "COMMIT"):
				// A transaction of tables without transactions (MyISAM) ends so, not with an XID.
				if err := commit(at, when); err != nil {
					return err
				}
			}
		case *replication.RowsEvent:
			if e.Table == nil || !wanted[[2]string{string(e.Table.Schema), string(e.Table.Table)}] {
				continue
			}
			for _, change := range rowsChanges(ev.Header.EventType, e) {
				change.Position = changePosition(start, index)
				index++
				pending = append(pending, change)
				size += approxSize(change)
				if len(pending) >= ChangesPerBatch || size >= BytesPerBatch {
					if err := emit(Batch{Type: "changes", CommittedAt: when, Changes: pending, Order: uint64(start)}); err != nil {
						return err
					}
					pending, size, parted = nil, 0, true
				}
			}
		case *replication.XIDEvent:
			if err := commit(at, when); err != nil {
				return err
			}
		}
	}
}

// spoolWaiting spools a batch, waiting while the spool is full: a server that keeps its own log
// (a binary log, change tracking) holds what is not read yet for its own retention.
func spoolWaiting(ctx context.Context, logger *slog.Logger, emit func(Batch) error, batch Batch) error {
	if batch.Changes == nil {
		batch.Changes = []Change{}
	}
	paused := false
	for {
		err := emit(batch)
		if err == nil {
			return nil
		}
		if !errors.Is(err, ErrFull) {
			return fmt.Errorf("cannot spool changes: %w", err)
		}
		if !paused {
			logger.Warn("the spool is full: reading waits for the cell", "event", "agent.cdc_paused")
			paused = true
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}

// rowsChanges are a rows event's changes: an update's rows come in pairs, its old image first.
func rowsChanges(kind replication.EventType, e *replication.RowsEvent) []Change {
	names := e.Table.ColumnNameString()
	schema, table := string(e.Table.Schema), string(e.Table.Table)
	collations := e.Table.CollationMap()
	enums, sets := e.Table.EnumStrValueMap(), e.Table.SetStrValueMap()
	row := func(values []any, only []uint64) map[string]any {
		out := make(map[string]any, len(values))
		take := func(i int) {
			if i >= len(values) || i >= len(names) {
				return
			}
			if labels, ok := enums[i]; ok {
				out[names[i]] = enumLabel(labels, values[i])
			} else if labels, ok := sets[i]; ok {
				out[names[i]] = setLabels(labels, values[i])
			} else {
				out[names[i]] = binlogValue(e.Table.ColumnType[i], collations[i], values[i])
			}
		}
		if only != nil {
			for _, i := range only {
				take(int(i))
			}
			return out
		}
		for i := range values {
			take(i)
		}
		return out
	}
	var changes []Change
	switch kind {
	case replication.WRITE_ROWS_EVENTv0, replication.WRITE_ROWS_EVENTv1, replication.WRITE_ROWS_EVENTv2:
		for _, r := range e.Rows {
			changes = append(changes, Change{Op: "insert", Schema: schema, Table: table, Values: row(r, nil)})
		}
	case replication.UPDATE_ROWS_EVENTv0, replication.UPDATE_ROWS_EVENTv1, replication.UPDATE_ROWS_EVENTv2:
		for i := 1; i < len(e.Rows); i += 2 {
			changes = append(changes, Change{Op: "update", Schema: schema, Table: table, Values: row(e.Rows[i], nil)})
		}
	case replication.DELETE_ROWS_EVENTv0, replication.DELETE_ROWS_EVENTv1, replication.DELETE_ROWS_EVENTv2:
		key := e.Table.PrimaryKey
		if len(key) == 0 {
			key = []uint64{}
		}
		for _, r := range e.Rows {
			changes = append(changes, Change{Op: "delete", Schema: schema, Table: table, Values: row(r, key)})
		}
	}
	return changes
}

// enumLabel is an ENUM's value as a read gives it: the binary log holds its number (1 the first
// label, 0 the empty string an invalid value is stored as).
func enumLabel(labels []string, v any) any {
	n, ok := v.(int64)
	if !ok {
		return binlogValue(0, 0, v)
	}
	if n >= 1 && int(n) <= len(labels) {
		return labels[n-1]
	}
	return ""
}

// setLabels is a SET's value as a read gives it: its members' labels, comma-separated, in the
// order the column defines them; the binary log holds a bit for each.
func setLabels(labels []string, v any) any {
	n, ok := v.(int64)
	if !ok {
		return binlogValue(0, 0, v)
	}
	members := make([]string, 0, len(labels))
	for i, label := range labels {
		if i < 64 && uint64(n)&(1<<uint(i)) != 0 {
			members = append(members, label)
		}
	}
	return strings.Join(members, ",")
}

// binlogValue is a logged column's value as the cell reads it, as a read gives it: integers as
// numbers (text beyond 2^53), decimals as their digits, moments in UTC, binary as hex, text as text.
func binlogValue(columnType byte, collation uint64, v any) any {
	switch t := v.(type) {
	case nil:
		return nil
	case int8:
		return int64(t)
	case int16:
		return int64(t)
	case int32:
		return int64(t)
	case int64:
		return values.JSON(t)
	case uint8:
		return int64(t)
	case uint16:
		return int64(t)
	case uint32:
		return int64(t)
	case uint64:
		if t > 1<<53 {
			return strconv.FormatUint(t, 10)
		}
		return int64(t)
	case float32:
		return float64(t)
	case float64:
		if math.IsNaN(t) || math.IsInf(t, 0) {
			return nil
		}
		return t
	case time.Time:
		if t.IsZero() {
			return nil
		}
		return values.JSON(t.UTC())
	case string:
		if collation == 63 {
			return "\\x" + hex.EncodeToString([]byte(t))
		}
		// A zero date or moment (allowed where the server's mode lets it in) is no date at all.
		switch columnType {
		case mysql.MYSQL_TYPE_DATE, mysql.MYSQL_TYPE_NEWDATE, mysql.MYSQL_TYPE_DATETIME, mysql.MYSQL_TYPE_DATETIME2,
			mysql.MYSQL_TYPE_TIMESTAMP, mysql.MYSQL_TYPE_TIMESTAMP2:
			if strings.HasPrefix(t, "0000-00-00") {
				return nil
			}
		}
		return t
	case []byte:
		if collation == 63 || (columnType != mysql.MYSQL_TYPE_JSON && collation == 0) {
			return "\\x" + hex.EncodeToString(t)
		}
		return string(t)
	case fmt.Stringer:
		return t.String()
	}
	return values.JSON(v)
}

// approxSize is roughly how many bytes a change carries, for the batch bound.
func approxSize(c Change) int {
	n := 64
	for k, v := range c.Values {
		n += len(k) + 16
		if s, ok := v.(string); ok {
			n += len(s)
		}
	}
	return n
}
