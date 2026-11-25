package work

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/hex"
	"errors"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
	"unsafe"

	go_ora "github.com/sijms/go-ora/v2"
	"github.com/sijms/go-ora/v2/configurations"
	"github.com/sijms/go-ora/v2/network"

	"silohq.io/agent/internal/login"
	"silohq.io/agent/internal/protocol"
	"silohq.io/agent/internal/values"
)

// oracleDialect reads and writes Oracle Database with go-ora (pure Go, no Oracle client); the
// cell's placeholders are :1, :2 and so on, bound in order. The login's database is the service
// name. A read is one SELECT (anything else is refused before it runs, as for SQL Server), in a
// transaction begun with SET TRANSACTION READ ONLY, which the server enforces as well (a write
// in it fails ORA-01456, kept as 25006), and rolled back. Oracle's clients log on without regard
// to the user name's case, so the login is an ordinary (unquoted) Oracle user.
type oracleDialect struct {
	mu    sync.Mutex
	pools map[string]*sql.DB
}

func newOracle() *oracleDialect { return &oracleDialect{pools: map[string]*sql.DB{}} }

// oracleConnector opens connections on a configuration the agent built, so a sealed password
// is a field of it, never part of a connection string.
type oracleConnector struct {
	config *configurations.ConnectionConfig
}

func (c oracleConnector) Connect(ctx context.Context) (driver.Conn, error) {
	conn, err := go_ora.NewConnection("", c.config)
	if err != nil {
		return nil, err
	}
	if err := conn.OpenWithContext(ctx); err != nil {
		return nil, err
	}
	return conn, nil
}

func (c oracleConnector) Driver() driver.Driver { return go_ora.NewDriver() }

// oracleURL is a login's place as go-ora reads it, with its TLS mode, and never a password.
func oracleURL(host, port, user, service, mode string) string {
	if port == "" {
		port = "1521"
	}
	query := url.Values{}
	switch mode {
	case "require":
		query.Set("SSL", "enable")
		query.Set("SSL VERIFY", "false")
	case "verify-full":
		query.Set("SSL", "enable")
		query.Set("SSL VERIFY", "true")
	}
	return (&url.URL{Scheme: "oracle", User: url.User(user), Host: net.JoinHostPort(host, port), Path: "/" + service, RawQuery: query.Encode()}).String()
}

func (o *oracleDialect) session(conn *sql.Conn, done func()) session {
	return &dbSession{conn: conn, done: done, value: oracleValue, beginRead: func(ctx context.Context, conn *sql.Conn, text string) (*sql.Tx, error) {
		if !singleSelect(text) {
			return nil, errNotARead
		}
		tx, err := conn.BeginTx(ctx, nil)
		if err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, "SET TRANSACTION READ ONLY"); err != nil {
			_ = tx.Rollback()
			return nil, err
		}
		return tx, nil
	}}
}

func (o *oracleDialect) held(ctx context.Context, connectionID, dsn string) (session, error) {
	o.mu.Lock()
	db, ok := o.pools[connectionID]
	if !ok {
		if !strings.HasPrefix(dsn, "oracle://") {
			o.mu.Unlock()
			return nil, errUnreachable
		}
		db = sql.OpenDB(go_ora.NewConnector(dsn))
		db.SetMaxOpenConns(4)
		db.SetMaxIdleConns(4)
		o.pools[connectionID] = db
	}
	o.mu.Unlock()
	conn, done, err := pooledConn(ctx, db)
	if err != nil {
		return nil, err
	}
	return o.session(conn, done), nil
}

// sealed opens one connection. The password reaches the driver as a view of its locked pages,
// never as a copy of the agent's own. TLS is as the login's mode says; prefer tries TLS, then
// the plain listener, as libpq does.
func (o *oracleDialect) sealed(ctx context.Context, l *login.Login, addrs []string) (session, error) {
	open := func(mode string) (session, error) {
		config, err := go_ora.ParseConfig(oracleURL(l.Host, l.Port, l.User, l.Database, mode))
		if err != nil {
			return nil, errUnreachable
		}
		if b := l.Password.Bytes(); len(b) > 0 {
			config.Password = unsafe.String(unsafe.SliceData(b), len(b))
		}
		if addrs != nil {
			config.Dialer = pinned{host: l.Host, addrs: addrs}
		}
		conn, done, err := oneConn(ctx, sql.OpenDB(oracleConnector{config: config}))
		if err != nil {
			return nil, err
		}
		return o.session(conn, done), nil
	}
	if l.SSLMode == "" || l.SSLMode == "prefer" {
		if s, err := open("require"); err == nil {
			return s, nil
		}
		return open("disable")
	}
	return open(l.SSLMode)
}

// oracleValue is a column's value as the cell reads it: numbers as numbers (their digits where
// a double would lose them), DATE and TIMESTAMP (which hold no zone) as their wall clock in UTC,
// zoned timestamps as the moment they are, RAW as hex.
func oracleValue(typeName string, v any) any {
	if v == nil {
		return nil
	}
	switch typeName {
	case "DATE", "TIMESTAMP", "TimeStampDTY":
		if t, ok := v.(time.Time); ok {
			return values.JSON(time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), t.Minute(), t.Second(), t.Nanosecond(), time.UTC))
		}
	case "RAW", "LongRaw", "OCIBlobLocator":
		if b, ok := v.([]byte); ok {
			return "\\x" + hex.EncodeToString(b)
		}
	case "NUMBER":
		// go-ora gives a NUMBER as its digits: a whole number a double holds exactly is a number
		// (NUMBER(1) flags among them), anything else keeps its digits, as decimals do elsewhere.
		if text, ok := v.(string); ok {
			if n, err := strconv.ParseInt(text, 10, 64); err == nil && n <= 1<<53 && n >= -(1<<53) {
				return n
			}
			return text
		}
	}
	switch n := v.(type) {
	case []byte:
		return string(n)
	case fmt.Stringer:
		if _, isTime := v.(time.Time); !isTime {
			return n.String()
		}
	}
	return values.JSON(v)
}

// oracleStates are the SQLSTATEs Oracle's error numbers stand for, so the cell classifies a
// refusal as it would any other database's.
var oracleStates = map[int]string{
	942: "42S02", 904: "42S22", 900: "42000", 933: "42000", 936: "42000", 1031: "42000",
	1017: "28000", 28000: "28000", 12514: "08001", 12505: "08001",
	1: "23000", 1400: "23000", 2291: "23000", 2292: "23000", 2290: "23000",
	1456: "25006", 8177: "40001", 60: "40001",
	12899: "22001", 1438: "22003", 1861: "22007", 1843: "22008", 1476: "22012",
}

// failure is the frame for a failed statement: the SQLSTATE Oracle's error number stands for.
func (o *oracleDialect) failure(ctx context.Context, err error) protocol.Error {
	if errors.Is(err, errNotARead) {
		return protocol.NewError(protocol.SourceRefused, "42000")
	}
	var ora *network.OracleError
	if errors.As(err, &ora) {
		state, ok := oracleStates[ora.ErrCode]
		if !ok {
			state = "HY000"
		}
		return protocol.NewError(protocol.SourceRefused, state)
	}
	return unreachableOr(ctx, err)
}

func (o *oracleDialect) close() {
	o.mu.Lock()
	defer o.mu.Unlock()
	for id, db := range o.pools {
		_ = db.Close()
		delete(o.pools, id)
	}
}
