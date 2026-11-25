package work

import (
	"context"
	"database/sql"
	"net"
	"time"
)

// dbSession is one call on a database/sql connection: SQL Server's and Oracle's. Each dialect
// says how a read begins (its read-only guard) and what a column's value is as the cell reads it.
type dbSession struct {
	conn *sql.Conn
	done func()
	// beginRead starts the read's transaction, refusing the statement if it is no read.
	beginRead func(ctx context.Context, conn *sql.Conn, text string) (*sql.Tx, error)
	value     func(typeName string, v any) any
}

func (s *dbSession) close() { s.done() }

func (s *dbSession) read(ctx context.Context, text string, args []any, row func(map[string]any) bool) error {
	tx, err := s.beginRead(ctx, s.conn, text)
	if err != nil {
		return err
	}
	// Always rolled back: a read keeps nothing.
	defer func() { _ = tx.Rollback() }()
	rows, err := tx.QueryContext(ctx, text, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	types, err := rows.ColumnTypes()
	if err != nil {
		return err
	}
	for rows.Next() {
		cells := make([]any, len(types))
		pointers := make([]any, len(types))
		for i := range cells {
			pointers[i] = &cells[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			return err
		}
		out := make(map[string]any, len(types))
		for i, t := range types {
			out[t.Name()] = s.value(t.DatabaseTypeName(), cells[i])
		}
		if !row(out) {
			return nil
		}
	}
	return rows.Err()
}

func (s *dbSession) write(ctx context.Context, statements []writeStatement) ([]int, error) {
	tx, err := s.conn.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	counts := make([]int, 0, len(statements))
	for i, statement := range statements {
		result, err := tx.ExecContext(ctx, statement.Text, statement.Values...)
		if err != nil {
			return nil, err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return nil, err
		}
		rows := int(n)
		if statement.ExpectRows != nil && rows != *statement.ExpectRows {
			return nil, &mismatch{index: i, rows: rows}
		}
		counts = append(counts, rows)
	}
	return counts, tx.Commit()
}

// pinned dials only the addresses the target check allowed, whatever the name resolves to later.
type pinned struct {
	host  string
	addrs []string
}

func (p pinned) HostName() string { return p.host }

func (p pinned) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	_, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	d := &net.Dialer{Timeout: 10 * time.Second}
	var last error
	for _, addr := range p.addrs {
		conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort(addr, port))
		if err == nil {
			return conn, nil
		}
		last = err
	}
	return nil, last
}

// pooledConn is a call's connection from a login's pool, given back when the call ends.
func pooledConn(ctx context.Context, db *sql.DB) (*sql.Conn, func(), error) {
	conn, err := db.Conn(ctx)
	if err != nil {
		return nil, nil, err
	}
	return conn, func() { _ = conn.Close() }, nil
}

// oneConn is a call's only connection on a sealed login, closed with its database when the call ends.
func oneConn(ctx context.Context, db *sql.DB) (*sql.Conn, func(), error) {
	db.SetMaxOpenConns(1)
	conn, err := db.Conn(ctx)
	if err != nil {
		_ = db.Close()
		return nil, nil, err
	}
	return conn, func() {
		_ = conn.Close()
		_ = db.Close()
	}, nil
}
