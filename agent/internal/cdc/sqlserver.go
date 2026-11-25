package cdc

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pglogrepl"
	mssql "github.com/microsoft/go-mssqldb"

	"silohq.io/agent/internal/values"
)

// ChangeTracking reads one capture from SQL Server's change tracking (spec 10.4): what changed in
// each captured table since a version, as SQL Server keeps it. It is read by polling, once a
// second, each read in a snapshot transaction, as SQL Server documents, so the version read
// and the changes agree.
//
//   - The database must track changes and allow snapshot isolation; each captured table must
//     track changes. Otherwise the reader refuses (ErrNotConfigured) and logs which.
//   - Change tracking keeps the net change of each row since a version (not every change on
//     the way), with the row's key; an insert and an update carry the row as it stands in the
//     snapshot, a delete its key's columns.
//   - Positions are change tracking's versions, written as Postgres LSNs are, so they compare as
//     numbers in the cell; a change's place is its row's version and its index there.
//   - SQL Server keeps tracking for its own retention (CHANGE_RETENTION). A capture whose last
//     version is older than what a table still holds is lost (ErrLost); nothing is kept on the
//     server for the reader, so acknowledging and dropping touch nothing there.
//   - Change tracking records no commit time: a change's time is when the agent read it, within
//     the poll of its commit.
type ChangeTracking struct {
	// DSN is the login: sqlserver://user:password@host:port?database=...
	DSN string
	// Tables are the (schema, table) pairs the capture reads.
	Tables [][2]string
	// Start is the last acknowledged position, or empty for the version the database is at now.
	Start   string
	Emit    func(Batch) error
	Logger  *slog.Logger
	Started func() error
	// PollEvery is how often the reader asks for changes (a second where zero).
	PollEvery time.Duration
}

// Ack is nothing to SQL Server: it keeps tracking by its own retention.
func (c *ChangeTracking) Ack(string) error { return nil }

// AtRiskNow is never: what the spool holds already left the server, and what it has not read
// waits there under the server's own retention.
func (c *ChangeTracking) AtRiskNow() bool { return false }

// quoted is an identifier as T-SQL quotes it.
func quoted(name string) string { return "[" + strings.ReplaceAll(name, "]", "]]") + "]" }

// tracked is a captured table as the reader queries it.
type tracked struct {
	schema, table string
	name          string // [schema].[table]
	key           []string
	query         string
}

func (c *ChangeTracking) Run(ctx context.Context) error {
	if !strings.HasPrefix(c.DSN, "sqlserver://") {
		return errors.New("the change tracking login is not a sqlserver:// URL")
	}
	connector, err := mssql.NewConnector(c.DSN)
	if err != nil {
		return errors.New("the change tracking login is not a valid sqlserver:// URL")
	}
	db := sql.OpenDB(connector)
	defer db.Close()
	db.SetMaxOpenConns(1)
	pollEvery := c.PollEvery
	if pollEvery <= 0 {
		pollEvery = time.Second
	}

	tables, err := c.prepare(ctx, db)
	if err != nil {
		return err
	}
	var last uint64
	if c.Start != "" {
		lsn, err := pglogrepl.ParseLSN(c.Start)
		if err != nil {
			return err
		}
		last = uint64(lsn)
	} else if err := db.QueryRowContext(ctx, "SELECT CHANGE_TRACKING_CURRENT_VERSION()").Scan(&last); err != nil {
		return err
	}
	c.Logger.Info("change capture started", "event", "agent.cdc_started", "method", "change_tracking")
	if c.Started != nil {
		if err := c.Started(); err != nil {
			return err
		}
	}
	lastMarker := time.Now()
	acknowledged := last
	for {
		version, changed, err := c.poll(ctx, db, tables, last)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		switch {
		case changed:
			acknowledged, lastMarker = version, time.Now()
		case version > acknowledged && time.Since(lastMarker) >= MarkerEvery:
			// Versions with no captured change go up as a position, so the cell keeps up.
			at := pglogrepl.LSN(version)
			if err := spoolWaiting(ctx, c.Logger, c.Emit, Batch{Type: "changes", Position: at.String(), CommittedAt: time.Now().UTC(), Changes: []Change{}, Order: version}); err != nil {
				return err
			}
			acknowledged, lastMarker = version, time.Now()
		}
		if version > last {
			last = version
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(pollEvery):
		}
	}
}

// prepare checks the database and each table track changes, and finds each table's key.
func (c *ChangeTracking) prepare(ctx context.Context, db *sql.DB) ([]tracked, error) {
	var snapshot sql.NullInt64
	if err := db.QueryRowContext(ctx, "SELECT snapshot_isolation_state FROM sys.databases WHERE database_id = DB_ID()").Scan(&snapshot); err != nil {
		return nil, err
	}
	if snapshot.Int64 != 1 {
		c.Logger.Warn("the source does not allow what change capture needs", "event", "agent.cdc_not_configured", "setting", "ALLOW_SNAPSHOT_ISOLATION", "needs", "ON")
		return nil, ErrNotConfigured
	}
	tables := make([]tracked, 0, len(c.Tables))
	for _, t := range c.Tables {
		name := quoted(t[0]) + "." + quoted(t[1])
		var min sql.NullInt64
		if err := db.QueryRowContext(ctx, "SELECT CHANGE_TRACKING_MIN_VALID_VERSION(OBJECT_ID(@p1))", name).Scan(&min); err != nil {
			return nil, err
		}
		if !min.Valid {
			// Not tracked, or not there, or not visible to the login: SQL Server does not say which.
			c.Logger.Warn("a captured table does not track changes", "event", "agent.cdc_not_configured", "setting", "CHANGE_TRACKING", "needs", "ENABLE")
			return nil, ErrNotConfigured
		}
		rows, err := db.QueryContext(ctx, `SELECT c.name FROM sys.indexes i
			JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
			JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
			WHERE i.object_id = OBJECT_ID(@p1) AND i.is_primary_key = 1 ORDER BY ic.key_ordinal`, name)
		if err != nil {
			return nil, err
		}
		var key []string
		for rows.Next() {
			var column string
			if err := rows.Scan(&column); err != nil {
				rows.Close()
				return nil, err
			}
			key = append(key, column)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, err
		}
		if len(key) == 0 {
			// Change tracking needs a primary key; a table tracking changes has one.
			return nil, ErrNotConfigured
		}
		selectKey := make([]string, len(key))
		join := make([]string, len(key))
		order := make([]string, len(key))
		for i, k := range key {
			selectKey[i] = "ct." + quoted(k)
			join[i] = "t." + quoted(k) + " = ct." + quoted(k)
			order[i] = "ct." + quoted(k)
		}
		query := fmt.Sprintf(`SELECT ct.SYS_CHANGE_VERSION, ct.SYS_CHANGE_OPERATION, %s, t.*
			FROM CHANGETABLE(CHANGES %s, @p1) AS ct LEFT OUTER JOIN %s AS t ON %s
			WHERE ct.SYS_CHANGE_VERSION <= @p2 ORDER BY ct.SYS_CHANGE_VERSION, %s`,
			strings.Join(selectKey, ", "), name, name, strings.Join(join, " AND "), strings.Join(order, ", "))
		tables = append(tables, tracked{schema: t[0], table: t[1], name: name, key: key, query: query})
	}
	return tables, nil
}

// poll reads every change after last, up to the version the database is at, in one snapshot.
func (c *ChangeTracking) poll(ctx context.Context, db *sql.DB, tables []tracked, last uint64) (version uint64, changed bool, err error) {
	tx, err := db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSnapshot})
	if err != nil {
		return 0, false, err
	}
	defer func() { _ = tx.Rollback() }()
	if err := tx.QueryRowContext(ctx, "SELECT CHANGE_TRACKING_CURRENT_VERSION()").Scan(&version); err != nil {
		return 0, false, err
	}
	if version <= last {
		return last, false, nil
	}
	for _, t := range tables {
		var min sql.NullInt64
		if err := tx.QueryRowContext(ctx, "SELECT CHANGE_TRACKING_MIN_VALID_VERSION(OBJECT_ID(@p1))", t.name).Scan(&min); err != nil {
			return 0, false, err
		}
		if !min.Valid {
			c.Logger.Warn("a captured table stopped tracking changes", "event", "agent.cdc_not_configured", "setting", "CHANGE_TRACKING", "needs", "ENABLE")
			return 0, false, ErrNotConfigured
		}
		if uint64(min.Int64) > last {
			// SQL Server has cleaned up (or restarted) tracking past what the cell has.
			return 0, false, ErrLost
		}
	}
	var (
		pending []Change
		size    int
		parted  bool
		now     = time.Now().UTC()
	)
	for _, t := range tables {
		rows, err := tx.QueryContext(ctx, t.query, int64(last), int64(version))
		if err != nil {
			return 0, false, err
		}
		columns, err := rows.ColumnTypes()
		if err != nil {
			rows.Close()
			return 0, false, err
		}
		keys := len(t.key)
		row := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for i := range row {
			pointers[i] = &row[i]
		}
		var (
			at    int64 = -1
			index int
		)
		for rows.Next() {
			if err := rows.Scan(pointers...); err != nil {
				rows.Close()
				return 0, false, err
			}
			changeVersion, _ := row[0].(int64)
			if changeVersion != at {
				at, index = changeVersion, 0
			}
			op := "update"
			switch operation, _ := row[1].(string); operation {
			case "I":
				op = "insert"
			case "D":
				op = "delete"
			}
			fields := map[string]any{}
			if op == "delete" {
				for i := 0; i < keys; i++ {
					fields[t.key[i]] = trackedValue(columns[2+i], row[2+i])
				}
			} else {
				present := false
				for i := 2 + keys; i < len(columns); i++ {
					fields[columns[i].Name()] = trackedValue(columns[i], row[i])
					if row[i] != nil {
						present = true
					}
				}
				if !present {
					// Gone from the snapshot since: its delete comes with a later version.
					continue
				}
			}
			change := Change{Op: op, Schema: t.schema, Table: t.table, Values: fields, Position: changePosition(pglogrepl.LSN(changeVersion), index)}
			index++
			pending = append(pending, change)
			size += approxSize(change)
			if len(pending) >= ChangesPerBatch || size >= BytesPerBatch {
				if err := spoolWaiting(ctx, c.Logger, c.Emit, Batch{Type: "changes", CommittedAt: now, Changes: pending, Order: last + 1}); err != nil {
					rows.Close()
					return 0, false, err
				}
				pending, size, parted = nil, 0, true
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return 0, false, err
		}
	}
	if len(pending) == 0 && !parted {
		return version, false, nil
	}
	at := pglogrepl.LSN(version)
	if err := spoolWaiting(ctx, c.Logger, c.Emit, Batch{Type: "changes", Position: at.String(), CommittedAt: now, Changes: pending, Order: version}); err != nil {
		return 0, false, err
	}
	return version, true, nil
}

// trackedValue is a tracked column's value as the cell reads it, as a read gives it.
func trackedValue(column *sql.ColumnType, v any) any {
	return values.SQLServer(column.DatabaseTypeName(), v)
}
