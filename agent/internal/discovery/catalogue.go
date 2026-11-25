package discovery

import (
	"context"
	"errors"
	"net"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// Catalogue introspection opens only catalogues this agent already holds credentials for (its
// connections), only where the system is one of the authorisation's targets, read-only, and
// runs only the statements below (Postgres) and in catalogue_sql.go (MySQL, SQL Server,
// Oracle): a fixed list compiled in, reading the catalogue, never a table. Row counts are the
// engines' estimates, so no table is scanned to count it.

const catalogueTimeout = 30 * time.Second

// The fixed list (spec 10.5). Partitions are read through their parent; system schemas are not read.
const (
	catalogueVersion = `select current_setting('server_version')`

	catalogueTables = `
select n.nspname, c.relname,
       case when c.relkind in ('r', 'p', 'm') and c.reltuples >= 0 then c.reltuples::bigint end
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p', 'v', 'm', 'f') and not c.relispartition
  and n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
order by 1, 2`

	catalogueColumns = `
select n.nspname, c.relname, a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod), not a.attnotnull
from pg_catalog.pg_attribute a
join pg_catalog.pg_class c on c.oid = a.attrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where a.attnum > 0 and not a.attisdropped and c.relkind in ('r', 'p', 'v', 'm', 'f') and not c.relispartition
  and n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
order by 1, 2, a.attnum`

	catalogueKeys = `
select n.nspname, c.relname, k.contype::text,
       array(select a.attname::text from unnest(k.conkey) with ordinality u(attnum, ord)
             join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.attnum order by u.ord),
       fn.nspname::text, fc.relname::text,
       array(select a.attname::text from unnest(coalesce(k.confkey, '{}')) with ordinality u(attnum, ord)
             join pg_catalog.pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.attnum order by u.ord)
from pg_catalog.pg_constraint k
join pg_catalog.pg_class c on c.oid = k.conrelid join pg_catalog.pg_namespace n on n.oid = c.relnamespace
left join pg_catalog.pg_class fc on fc.oid = k.confrelid left join pg_catalog.pg_namespace fn on fn.oid = fc.relnamespace
where k.contype in ('p', 'u', 'f') and not c.relispartition
  and n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
order by 1, 2, k.conname`
)

// catalogues introspects each held database whose host is a target.
func (r *run) catalogues() {
	if r.settings.Databases == nil {
		return
	}
	held := r.settings.Databases()
	ids := make([]string, 0, len(held))
	for id := range held {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if !r.going() {
			return
		}
		target, ok := heldOf(held[id])
		if !ok {
			r.settings.Logger.Warn("a connection's DSN does not parse; not introspected", "event", "agent.discovery_dsn_invalid", "connection_id", id)
			continue
		}
		host, ok := r.targets.Match(r.ctx, target.host, r.settings.Resolve)
		if !ok || !r.bound.admit(host) {
			continue
		}
		select {
		case <-r.ctx.Done():
			return
		case <-r.pace:
		}
		port := target.port
		found, outcome := target.introspect(r.ctx)
		if !r.probe(host, port, MethodCatalogue, outcome) {
			return
		}
		if outcome == Identified {
			for _, part := range splitFound(found) {
				if !r.finding(host, MethodCatalogue, part) {
					return
				}
			}
		}
	}
}

// heldDatabase is a held connection as introspection opens it: its dialect by its DSN.
type heldDatabase struct {
	host       string
	port       int
	introspect func(ctx context.Context) (Found, string)
}

// heldOf reads a held connection's DSN: mysql:// or mariadb://, sqlserver://, oracle://, or
// else Postgres's (a URL or key=value pairs).
func heldOf(dsn string) (heldDatabase, bool) {
	for prefix, dialect := range map[string]struct {
		port int
		read func(context.Context, string) (Found, string)
	}{
		"mysql://": {3306, introspectMySQL}, "mariadb://": {3306, introspectMySQL}, "sqlserver://": {1433, introspectSQLServer}, "oracle://": {1521, introspectOracle},
	} {
		if !strings.HasPrefix(dsn, prefix) {
			continue
		}
		u, err := url.Parse(dsn)
		if err != nil || u.Hostname() == "" {
			return heldDatabase{}, false
		}
		read := dialect.read
		return heldDatabase{host: u.Hostname(), port: portOf(u, dialect.port), introspect: func(ctx context.Context) (Found, string) { return read(ctx, dsn) }}, true
	}
	config, err := pgx.ParseConfig(dsn)
	if err != nil {
		return heldDatabase{}, false
	}
	return heldDatabase{host: config.Host, port: int(config.Port), introspect: func(ctx context.Context) (Found, string) { return introspect(ctx, config) }}, true
}

// catalogue gathers one database's structure as its catalogue gives it, bounded as a finding is.
type catalogue struct {
	schemas map[string]map[string]*Table
	order   []struct{ schema, table string }
}

func newCatalogue() *catalogue { return &catalogue{schemas: map[string]map[string]*Table{}} }

func (c *catalogue) lookup(schema, name string) *Table {
	if c.schemas[schema] == nil {
		return nil
	}
	return c.schemas[schema][name]
}

// table adds a table or view, once, with its estimated row count where the engine keeps one.
func (c *catalogue) table(schema, name string, count *int64) {
	if c.lookup(schema, name) != nil {
		return
	}
	if c.schemas[schema] == nil {
		c.schemas[schema] = map[string]*Table{}
	}
	c.schemas[schema][name] = &Table{Name: name, RowCount: count, Columns: []Column{}, PrimaryKey: []string{}, UniqueKeys: [][]string{}, ForeignKeys: []ForeignKey{}}
	c.order = append(c.order, struct{ schema, table string }{schema, name})
}

func (c *catalogue) column(schema, name, column, typ string, nullable bool) {
	if t := c.lookup(schema, name); t != nil && len(t.Columns) < maxColumns {
		t.Columns = append(t.Columns, Column{Name: column, Type: clip(typ, maxTypeName), Nullable: nullable})
	}
}

// key adds a primary (p), unique (u) or foreign (f) key, its columns in key order.
func (c *catalogue) key(schema, name, kind string, columns []string, targetSchema, targetTable *string, targetColumns []string) {
	t := c.lookup(schema, name)
	if t == nil || len(columns) == 0 || len(columns) > maxKeyColumns {
		return
	}
	switch kind {
	case "p":
		t.PrimaryKey = columns
	case "u":
		if len(t.UniqueKeys) < maxUniqueKeys {
			t.UniqueKeys = append(t.UniqueKeys, columns)
		}
	case "f":
		if targetTable != nil && len(targetColumns) == len(columns) && len(t.ForeignKeys) < maxForeign {
			t.ForeignKeys = append(t.ForeignKeys, ForeignKey{Columns: columns, TargetSchema: targetSchema, TargetTable: *targetTable, TargetColumns: targetColumns})
		}
	}
}

// found is the catalogue as a finding: schemas and tables in the order read, within the bounds.
func (c *catalogue) found(port int, product, version, dialect string) Found {
	found := service(port, product, version, "sql", dialect)
	byName := map[string]int{}
	for _, o := range c.order {
		i, ok := byName[o.schema]
		if !ok {
			if len(found.Schemas) >= maxSchemas {
				continue
			}
			found.Schemas = append(found.Schemas, Schema{Name: o.schema, Tables: []Table{}})
			i = len(found.Schemas) - 1
			byName[o.schema] = i
		}
		if len(found.Schemas[i].Tables) < maxTables {
			found.Schemas[i].Tables = append(found.Schemas[i].Tables, *c.schemas[o.schema][o.table])
		}
	}
	return found
}

// introspect reads one Postgres catalogue in a read-only transaction.
func introspect(ctx context.Context, config *pgx.ConnConfig) (Found, string) {
	ctx, cancel := context.WithTimeout(ctx, catalogueTimeout)
	defer cancel()
	config.ConnectTimeout = 10 * time.Second
	config.RuntimeParams["application_name"] = "silo-agent-discovery"
	conn, err := pgx.ConnectConfig(ctx, config)
	if err != nil {
		return Found{}, outcomeOf(err)
	}
	defer conn.Close(context.Background())
	tx, err := conn.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return Found{}, outcomeOf(err)
	}
	defer tx.Rollback(context.Background()) //nolint:errcheck // read-only; nothing to keep
	if _, err := tx.Exec(ctx, "set local statement_timeout = '20s'"); err != nil {
		return Found{}, outcomeOf(err)
	}
	var version string
	if err := tx.QueryRow(ctx, catalogueVersion).Scan(&version); err != nil {
		return Found{}, outcomeOf(err)
	}
	c := newCatalogue()

	rows, err := tx.Query(ctx, catalogueTables)
	if err != nil {
		return Found{}, outcomeOf(err)
	}
	for rows.Next() {
		var schema, name string
		var count *int64
		if err := rows.Scan(&schema, &name, &count); err != nil {
			rows.Close()
			return Found{}, Error
		}
		c.table(schema, name, count)
	}
	rows.Close()
	if rows.Err() != nil {
		return Found{}, outcomeOf(rows.Err())
	}

	rows, err = tx.Query(ctx, catalogueColumns)
	if err != nil {
		return Found{}, outcomeOf(err)
	}
	for rows.Next() {
		var schema, name, column, typ string
		var nullable bool
		if err := rows.Scan(&schema, &name, &column, &typ, &nullable); err != nil {
			rows.Close()
			return Found{}, Error
		}
		c.column(schema, name, column, typ, nullable)
	}
	rows.Close()
	if rows.Err() != nil {
		return Found{}, outcomeOf(rows.Err())
	}

	rows, err = tx.Query(ctx, catalogueKeys)
	if err != nil {
		return Found{}, outcomeOf(err)
	}
	for rows.Next() {
		var schema, name, kind string
		var columns, targetColumns []string
		var targetSchema, targetTable *string
		if err := rows.Scan(&schema, &name, &kind, &columns, &targetSchema, &targetTable, &targetColumns); err != nil {
			rows.Close()
			return Found{}, Error
		}
		c.key(schema, name, kind, columns, targetSchema, targetTable, targetColumns)
	}
	rows.Close()
	if rows.Err() != nil {
		return Found{}, outcomeOf(rows.Err())
	}

	return c.found(int(config.Port), "PostgreSQL", firstWord(version), "postgres"), Identified
}

// outcomeOf names how a catalogue turned the agent away: credentials or privileges refused,
// or anything else.
func outcomeOf(err error) string {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && (pgErr.Code == "28P01" || pgErr.Code == "28000" || pgErr.Code == "42501") {
		return Refused
	}
	var netErr net.Error
	if errors.As(err, &netErr) || errors.Is(err, context.DeadlineExceeded) {
		return Closed
	}
	return Error
}

func firstWord(s string) string {
	for i, r := range s {
		if r == ' ' {
			return s[:i]
		}
	}
	return s
}

func clip(s string, limit int) string {
	if p := text(s, limit); p != nil {
		return *p
	}
	return "unknown"
}

// maxFindingBytes keeps a finding well inside the tunnel's 4 MB frame.
const maxFindingBytes = 3 << 20

// splitFound is a catalogue as findings each within a frame: whole, or a schema at a time, a
// schema too large for one cut to the tables that fit.
func splitFound(found Found) []Found {
	if size(found) <= maxFindingBytes {
		return []Found{found}
	}
	var parts []Found
	for _, schema := range found.Schemas {
		part := found
		part.Schemas = []Schema{{Name: schema.Name, Tables: schema.Tables}}
		for size(part) > maxFindingBytes && len(part.Schemas[0].Tables) > 1 {
			part.Schemas[0].Tables = part.Schemas[0].Tables[:len(part.Schemas[0].Tables)*3/4]
		}
		parts = append(parts, part)
	}
	return parts
}

// size estimates a finding's JSON without encoding it: names and types, with room for syntax.
func size(found Found) int {
	n := 512
	for _, s := range found.Schemas {
		n += len(s.Name) + 32
		for _, t := range s.Tables {
			n += len(t.Name) + 96
			for _, c := range t.Columns {
				n += len(c.Name) + len(c.Type) + 48
			}
			n += names(t.PrimaryKey)
			for _, k := range t.UniqueKeys {
				n += names(k) + 4
			}
			for _, f := range t.ForeignKeys {
				n += 96 + len(f.TargetTable) + names(f.Columns) + names(f.TargetColumns)
				if f.TargetSchema != nil {
					n += len(*f.TargetSchema)
				}
			}
		}
	}
	return n
}

// names is the JSON size of a list of names, near enough: each quoted, with its comma, and
// room for a character that must be escaped.
func names(list []string) int {
	n := 2
	for _, s := range list {
		n += len(s)*2 + 3
	}
	return n
}

// portOf is the port in a DSN-like URL, or the default given.
func portOf(u *url.URL, fallback int) int {
	if p, err := strconv.Atoi(u.Port()); err == nil && p > 0 && p < 65536 {
		return p
	}
	return fallback
}
