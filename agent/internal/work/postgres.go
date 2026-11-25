package work

import (
	"context"
	"errors"
	"net"
	"net/url"
	"strings"
	"sync"
	"unsafe"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"silohq.io/agent/internal/login"
	"silohq.io/agent/internal/protocol"
	"silohq.io/agent/internal/values"
)

// postgres reads and writes Postgres with pgx: a read in a read-only transaction, which the
// server enforces.
type postgres struct {
	mu    sync.Mutex
	pools map[string]*pgxpool.Pool
}

func newPostgres() *postgres { return &postgres{pools: map[string]*pgxpool.Pool{}} }

// pgSession is a pool's or one connection's: what a transaction starts on.
type pgSession struct {
	db interface {
		BeginTx(ctx context.Context, options pgx.TxOptions) (pgx.Tx, error)
	}
	done func()
}

func (p *postgres) held(ctx context.Context, connectionID, dsn string) (session, error) {
	if strings.Contains(dsn, "://") && !strings.HasPrefix(dsn, "postgres://") && !strings.HasPrefix(dsn, "postgresql://") {
		return nil, errUnreachable
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	pool, ok := p.pools[connectionID]
	if !ok {
		cfg, err := pgxpool.ParseConfig(dsn)
		if err != nil {
			return nil, errUnreachable
		}
		cfg.MaxConns = 4
		if pool, err = pgxpool.NewWithConfig(ctx, cfg); err != nil {
			return nil, errUnreachable
		}
		p.pools[connectionID] = pool
	}
	return &pgSession{db: pool, done: func() {}}, nil
}

// sealed opens one connection. The password is handed to the driver as a view of its locked
// pages, wiped when the call ends, never as a copy of the agent's own; the driver's own working
// copies during authentication are its to drop.
func (p *postgres) sealed(ctx context.Context, l *login.Login, addrs []string) (session, error) {
	port := l.Port
	if port == "" {
		port = "5432"
	}
	mode := l.SSLMode
	if mode == "" {
		mode = "prefer"
	}
	where := url.URL{Scheme: "postgres", Host: net.JoinHostPort(l.Host, port), Path: "/" + l.Database, RawQuery: url.Values{"sslmode": {mode}}.Encode()}
	cfg, err := pgx.ParseConfig(where.String())
	if err != nil {
		return nil, errUnreachable
	}
	cfg.User = l.User
	if password := l.Password.Bytes(); len(password) > 0 {
		cfg.Password = unsafe.String(unsafe.SliceData(password), len(password))
	}
	if addrs != nil {
		// Reached at the addresses the target check allowed, whatever the name resolves to later.
		cfg.LookupFunc = func(context.Context, string) ([]string, error) { return addrs, nil }
	}
	conn, err := pgx.ConnectConfig(ctx, cfg)
	cfg.Password = ""
	if err != nil {
		return nil, err
	}
	return &pgSession{db: conn, done: func() { _ = conn.Close(context.Background()) }}, nil
}

func (s *pgSession) close() { s.done() }

func (s *pgSession) read(ctx context.Context, text string, args []any, row func(map[string]any) bool) error {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	rows, err := tx.Query(ctx, text, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	fields := rows.FieldDescriptions()
	for rows.Next() {
		got, err := rows.Values()
		if err != nil {
			return err
		}
		out := make(map[string]any, len(fields))
		for i, f := range fields {
			out[f.Name] = values.ForColumn(f.DataTypeOID, got[i])
		}
		if !row(out) {
			return nil
		}
	}
	return rows.Err()
}

func (s *pgSession) write(ctx context.Context, statements []writeStatement) ([]int, error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadWrite})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	counts := make([]int, 0, len(statements))
	for i, statement := range statements {
		tag, err := tx.Exec(ctx, statement.Text, statement.Values...)
		if err != nil {
			return nil, err
		}
		rows := int(tag.RowsAffected())
		if statement.ExpectRows != nil && rows != *statement.ExpectRows {
			return nil, &mismatch{index: i, rows: rows}
		}
		counts = append(counts, rows)
	}
	return counts, tx.Commit(ctx)
}

// failure is the frame for a failed statement: the source's SQLSTATE where it refused.
func (p *postgres) failure(ctx context.Context, err error) protocol.Error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return protocol.NewError(protocol.SourceRefused, pgErr.Code)
	}
	return unreachableOr(ctx, err)
}

func (p *postgres) close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, pool := range p.pools {
		pool.Close()
	}
}
