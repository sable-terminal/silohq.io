package work

import (
	"context"
	"database/sql"
	"errors"
	"net"
	"net/url"
	"strings"
	"sync"
	"unsafe"

	mssql "github.com/microsoft/go-mssqldb"
	"github.com/microsoft/go-mssqldb/msdsn"

	"silohq.io/agent/internal/login"
	"silohq.io/agent/internal/protocol"
	"silohq.io/agent/internal/values"
)

// sqlServer reads and writes Microsoft SQL Server (and Azure SQL) with go-mssqldb; the cell's
// placeholders are @p1, @p2 and so on, bound in order.
//
// SQL Server has no read-only transaction. A read is one SELECT, and nothing else (no second
// statement), run in a transaction that is always rolled back, so anything it might change is
// undone; the login's own permissions (db_datareader, and db_datawriter only where writes are
// granted) are what stop a write. Errors are SQL Server's numbers, kept as the SQLSTATE they
// stand for.
type sqlServer struct {
	mu    sync.Mutex
	pools map[string]*sql.DB
}

func newSQLServer() *sqlServer { return &sqlServer{pools: map[string]*sql.DB{}} }

// sqlServerURL is a login's place as go-mssqldb reads it, with its TLS mode, and never a password.
func sqlServerURL(host, port, user, database, mode string) string {
	if port == "" {
		port = "1433"
	}
	query := url.Values{"database": {database}, "app name": {"silo-agent"}}
	switch mode {
	case "disable":
		query.Set("encrypt", "disable")
	case "verify-full":
		query.Set("encrypt", "true")
		query.Set("hostnameincertificate", host)
	default: // prefer and require: encrypted, the certificate not checked, as libpq's
		query.Set("encrypt", "true")
		query.Set("TrustServerCertificate", "true")
	}
	return (&url.URL{Scheme: "sqlserver", User: url.User(user), Host: net.JoinHostPort(host, port), RawQuery: query.Encode()}).String()
}

func (m *sqlServer) held(ctx context.Context, connectionID, dsn string) (session, error) {
	m.mu.Lock()
	db, ok := m.pools[connectionID]
	if !ok {
		if !strings.HasPrefix(dsn, "sqlserver://") {
			m.mu.Unlock()
			return nil, errUnreachable
		}
		connector, err := mssql.NewConnector(dsn)
		if err != nil {
			m.mu.Unlock()
			return nil, errUnreachable
		}
		db = sql.OpenDB(connector)
		db.SetMaxOpenConns(4)
		db.SetMaxIdleConns(4)
		m.pools[connectionID] = db
	}
	m.mu.Unlock()
	conn, done, err := pooledConn(ctx, db)
	if err != nil {
		return nil, err
	}
	return m.session(conn, done), nil
}

func (m *sqlServer) session(conn *sql.Conn, done func()) session {
	return &dbSession{conn: conn, done: done, value: values.SQLServer, beginRead: func(ctx context.Context, conn *sql.Conn, text string) (*sql.Tx, error) {
		if !singleSelect(text) {
			return nil, errNotARead
		}
		return conn.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	}}
}

// sealed opens one connection. The password reaches the driver as a view of its locked pages,
// never as a copy of the agent's own.
func (m *sqlServer) sealed(ctx context.Context, l *login.Login, addrs []string) (session, error) {
	cfg, err := msdsn.Parse(sqlServerURL(l.Host, l.Port, l.User, l.Database, l.SSLMode))
	if err != nil {
		return nil, errUnreachable
	}
	if b := l.Password.Bytes(); len(b) > 0 {
		cfg.Password = unsafe.String(unsafe.SliceData(b), len(b))
	}
	connector := mssql.NewConnectorConfig(cfg)
	if addrs != nil {
		connector.Dialer = pinned{host: l.Host, addrs: addrs}
	}
	conn, done, err := oneConn(ctx, sql.OpenDB(connector))
	if err != nil {
		return nil, err
	}
	return m.session(conn, done), nil
}

// singleSelect says whether a read is one SELECT: no second statement rides on it.
func singleSelect(text string) bool {
	t := strings.TrimSpace(strings.ToLower(text))
	return (strings.HasPrefix(t, "select ") || strings.HasPrefix(t, "with ")) && !strings.Contains(strings.TrimSuffix(t, ";"), ";")
}

var errNotARead = errors.New("a read is one select")

// sqlStates are the SQLSTATEs SQL Server's error numbers stand for, so the cell classifies a
// refusal as it would any other database's.
var sqlStates = map[int32]string{
	208: "42S02", 207: "42S22", 102: "42000", 156: "42000", 4104: "42000",
	229: "42000", 230: "42000", 262: "42000", 297: "42000", 300: "42000",
	18456: "28000", 4060: "08004",
	2627: "23000", 2601: "23000", 547: "23000", 515: "23000",
	1205: "40001", 3960: "40001", 1222: "HYT00",
	3906: "25006", 8152: "22001", 2628: "22001", 8115: "22003", 241: "22007", 242: "22008", 8134: "22012",
}

// failure is the frame for a failed statement: the SQLSTATE SQL Server's error number stands for.
func (m *sqlServer) failure(ctx context.Context, err error) protocol.Error {
	if errors.Is(err, errNotARead) {
		return protocol.NewError(protocol.SourceRefused, "42000")
	}
	var ms mssql.Error
	if errors.As(err, &ms) {
		state, ok := sqlStates[ms.Number]
		if !ok {
			state = "HY000"
		}
		return protocol.NewError(protocol.SourceRefused, state)
	}
	return unreachableOr(ctx, err)
}

func (m *sqlServer) close() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, db := range m.pools {
		_ = db.Close()
		delete(m.pools, id)
	}
}
