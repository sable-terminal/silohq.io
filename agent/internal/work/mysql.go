package work

import (
	"context"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unsafe"

	"github.com/go-mysql-org/go-mysql/client"
	"github.com/go-mysql-org/go-mysql/mysql"

	"silohq.io/agent/internal/login"
	"silohq.io/agent/internal/protocol"
	"silohq.io/agent/internal/values"
)

// mysqlDialect reads and writes MySQL (and MariaDB) with go-mysql's client, on the binary
// protocol with prepared statements (the cell's placeholders are ?). A read runs in START
// TRANSACTION READ ONLY, which the server enforces (a write in it fails as 25006, as in
// Postgres), and is rolled back. Every session counts rows found, not only rows changed, so an
// update that sets a value already there still counts the row it matched (expectRows), and runs
// in UTC, so a TIMESTAMP reads as the moment it is.
type mysqlDialect struct {
	mu   sync.Mutex
	idle map[string][]*client.Conn
}

func newMySQL() *mysqlDialect { return &mysqlDialect{idle: map[string][]*client.Conn{}} }

const mysqlIdlePerConnection = 4

type mySession struct {
	conn   *client.Conn
	broken bool
	done   func(*mySession)
}

// connect opens one connection. A sealed password reaches the client as a view of its locked
// pages, never as a copy of the agent's own.
func (m *mysqlDialect) connect(ctx context.Context, host, port, user, password, database, mode string, addrs []string) (*client.Conn, error) {
	if port == "" {
		port = "3306"
	}
	dialer := func(ctx context.Context, network, address string) (net.Conn, error) {
		d := &net.Dialer{Timeout: 10 * time.Second}
		if addrs == nil {
			return d.DialContext(ctx, network, address)
		}
		// Reached at the addresses the target check allowed, whatever the name resolves to later.
		var last error
		for _, addr := range addrs {
			conn, err := d.DialContext(ctx, network, net.JoinHostPort(addr, port))
			if err == nil {
				return conn, nil
			}
			last = err
		}
		return nil, last
	}
	attempt := func(useTLS bool) (*client.Conn, error) {
		options := []client.Option{func(c *client.Conn) error { return c.SetCapability(mysql.CLIENT_FOUND_ROWS) }}
		if useTLS {
			options = append(options, func(c *client.Conn) error {
				// verify-full checks the server's certificate and name; require and prefer encrypt only, as libpq does.
				c.SetTLSConfig(&tls.Config{ServerName: host, MinVersion: tls.VersionTLS12, InsecureSkipVerify: mode != "verify-full"})
				return nil
			})
		}
		return client.ConnectWithDialer(ctx, "tcp", net.JoinHostPort(host, port), user, password, database, dialer, options...)
	}
	conn, err := attempt(mode != "disable")
	if err != nil && (mode == "" || mode == "prefer") && strings.Contains(err.Error(), "does not support TLS") {
		conn, err = attempt(false)
	}
	if err != nil {
		return nil, err
	}
	if err := conn.SetCharset("utf8mb4"); err != nil {
		conn.Close()
		return nil, err
	}
	if _, err := conn.Execute("SET time_zone = '+00:00'"); err != nil {
		conn.Close()
		return nil, err
	}
	return conn, nil
}

func (m *mysqlDialect) held(ctx context.Context, connectionID, dsn string) (session, error) {
	m.mu.Lock()
	if idle := m.idle[connectionID]; len(idle) > 0 {
		conn := idle[len(idle)-1]
		m.idle[connectionID] = idle[:len(idle)-1]
		m.mu.Unlock()
		if conn.Ping() == nil {
			return m.session(conn, connectionID), nil
		}
		conn.Close()
	} else {
		m.mu.Unlock()
	}
	u, err := url.Parse(dsn)
	if err != nil || (u.Scheme != "mysql" && u.Scheme != "mariadb") || u.User == nil {
		return nil, errUnreachable
	}
	password, _ := u.User.Password()
	conn, err := m.connect(ctx, u.Hostname(), u.Port(), u.User.Username(), password, strings.TrimPrefix(u.Path, "/"), u.Query().Get("sslmode"), nil)
	if err != nil {
		return nil, err
	}
	return m.session(conn, connectionID), nil
}

// session hands the connection back to its connection's idle list when the call ends cleanly.
func (m *mysqlDialect) session(conn *client.Conn, connectionID string) *mySession {
	return &mySession{conn: conn, done: func(s *mySession) {
		m.mu.Lock()
		defer m.mu.Unlock()
		if s.broken || len(m.idle[connectionID]) >= mysqlIdlePerConnection {
			s.conn.Close()
			return
		}
		m.idle[connectionID] = append(m.idle[connectionID], s.conn)
	}}
}

func (m *mysqlDialect) sealed(ctx context.Context, l *login.Login, addrs []string) (session, error) {
	password := ""
	if b := l.Password.Bytes(); len(b) > 0 {
		password = unsafe.String(unsafe.SliceData(b), len(b))
	}
	conn, err := m.connect(ctx, l.Host, l.Port, l.User, password, l.Database, l.SSLMode, addrs)
	if err != nil {
		return nil, err
	}
	return &mySession{conn: conn, done: func(s *mySession) { s.conn.Close() }}, nil
}

func (s *mySession) close() { s.done(s) }

// watch ends a statement the work's deadline overtakes: the connection's own deadline is set
// to now, the call fails as a timeout, and the connection is not kept.
func (s *mySession) watch(ctx context.Context) func() bool {
	return context.AfterFunc(ctx, func() {
		s.broken = true
		_ = s.conn.SetDeadline(time.Now())
	})
}

var errStop = errors.New("enough rows")

func (s *mySession) read(ctx context.Context, text string, args []any, row func(map[string]any) bool) error {
	defer s.watch(ctx)()
	if _, err := s.conn.Execute("START TRANSACTION READ ONLY"); err != nil {
		s.broken = true
		return err
	}
	stmt, err := s.conn.Prepare(text)
	if err != nil {
		s.rollback()
		return err
	}
	defer stmt.Close()
	var result mysql.Result
	err = stmt.ExecuteSelectStreaming(&result, func(fields []mysql.FieldValue) error {
		out := make(map[string]any, len(fields))
		for i, f := range result.Fields {
			out[string(f.Name)] = mysqlValue(f, &fields[i])
		}
		if !row(out) {
			return errStop
		}
		return nil
	}, nil, mysqlArgs(args)...)
	if err != nil && errors.Is(err, errStop) {
		// The rest of the result is still on the wire: the connection is not kept.
		s.broken = true
		return nil
	}
	s.rollback()
	return err
}

func (s *mySession) rollback() {
	if _, err := s.conn.Execute("ROLLBACK"); err != nil {
		s.broken = true
	}
}

func (s *mySession) write(ctx context.Context, statements []writeStatement) ([]int, error) {
	defer s.watch(ctx)()
	if _, err := s.conn.Execute("START TRANSACTION"); err != nil {
		s.broken = true
		return nil, err
	}
	counts := make([]int, 0, len(statements))
	for i, statement := range statements {
		result, err := s.conn.Execute(statement.Text, mysqlArgs(statement.Values)...)
		if err != nil {
			s.rollback()
			return nil, err
		}
		rows := int(result.AffectedRows)
		result.Close()
		if statement.ExpectRows != nil && rows != *statement.ExpectRows {
			s.rollback()
			return nil, &mismatch{index: i, rows: rows}
		}
		counts = append(counts, rows)
	}
	if _, err := s.conn.Execute("COMMIT"); err != nil {
		s.broken = true
		return nil, err
	}
	return counts, nil
}

// mysqlArgs binds values as the client takes them: a boolean as 1 or 0.
func mysqlArgs(args []any) []any {
	out := make([]any, len(args))
	for i, a := range args {
		if b, ok := a.(bool); ok {
			if b {
				a = int64(1)
			} else {
				a = int64(0)
			}
		}
		out[i] = a
	}
	return out
}

// mysqlValue is a column's value as the cell reads it: numerics as their digits, moments in UTC
// to the millisecond, dates as dates, binary as hex, text as text.
func mysqlValue(f *mysql.Field, v *mysql.FieldValue) any {
	switch v.Type {
	case mysql.FieldValueTypeNull:
		return nil
	case mysql.FieldValueTypeUnsigned:
		u := v.AsUint64()
		if u > 1<<53 {
			return strconv.FormatUint(u, 10)
		}
		return int64(u)
	case mysql.FieldValueTypeSigned:
		return values.JSON(v.AsInt64())
	case mysql.FieldValueTypeFloat:
		return v.AsFloat64()
	}
	b := v.AsString()
	switch f.Type {
	case mysql.MYSQL_TYPE_DATETIME, mysql.MYSQL_TYPE_TIMESTAMP, mysql.MYSQL_TYPE_DATETIME2, mysql.MYSQL_TYPE_TIMESTAMP2:
		t, err := time.ParseInLocation("2006-01-02 15:04:05.999999", string(b), time.UTC)
		if err != nil {
			return nil // a zero date has no moment
		}
		return values.JSON(t)
	case mysql.MYSQL_TYPE_DATE, mysql.MYSQL_TYPE_NEWDATE:
		if strings.HasPrefix(string(b), "0000") {
			return nil
		}
		return string(b)
	case mysql.MYSQL_TYPE_BIT:
		var n uint64
		for _, c := range b {
			n = n<<8 | uint64(c)
		}
		return int64(n)
	case mysql.MYSQL_TYPE_DECIMAL, mysql.MYSQL_TYPE_NEWDECIMAL, mysql.MYSQL_TYPE_TIME, mysql.MYSQL_TYPE_YEAR, mysql.MYSQL_TYPE_JSON,
		mysql.MYSQL_TYPE_ENUM, mysql.MYSQL_TYPE_SET:
		return string(b)
	}
	if f.Charset == 63 { // binary: BLOB, BINARY, VARBINARY
		return "\\x" + hex.EncodeToString(b)
	}
	return string(b)
}

// failure is the frame for a failed statement: MySQL's own SQLSTATE where it refused.
func (m *mysqlDialect) failure(ctx context.Context, err error) protocol.Error {
	var my *mysql.MyError
	if errors.As(err, &my) {
		state := my.State
		if len(state) != 5 {
			state = "HY000"
		}
		return protocol.NewError(protocol.SourceRefused, state)
	}
	return unreachableOr(ctx, err)
}

func (m *mysqlDialect) close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, idle := range m.idle {
		for _, conn := range idle {
			conn.Close()
		}
		delete(m.idle, id)
	}
}
