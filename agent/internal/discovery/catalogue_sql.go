package discovery

import (
	"context"
	"crypto/tls"
	"database/sql"
	"errors"
	"net"
	"net/url"
	"strings"
	"time"

	"github.com/go-mysql-org/go-mysql/client"
	"github.com/go-mysql-org/go-mysql/mysql"
	mssql "github.com/microsoft/go-mssqldb"
	go_ora "github.com/sijms/go-ora/v2"
	"github.com/sijms/go-ora/v2/network"
)

// Catalogue introspection of MySQL, SQL Server and Oracle (spec 19.3, 10.5), as Postgres's: a
// fixed list of statements compiled in per dialect, each reading the catalogue (MySQL's
// information_schema, SQL Server's sys views, Oracle's ALL_ views), never a table. Row counts
// are the engine's own statistics (information_schema.tables.table_rows, sys.partitions,
// all_tables.num_rows), so no table is scanned to count it. MySQL and Oracle read in a
// read-only transaction; SQL Server has none, and runs only the selects below. System schemas
// are not read: MySQL's own, SQL Server's shipped objects, Oracle's maintained users.

const mysqlSystem = `('mysql', 'information_schema', 'performance_schema', 'sys')`

const (
	mysqlVersion = `select version()`
	mysqlTables  = `
select table_schema, table_name, table_rows from information_schema.tables
where table_schema not in ` + mysqlSystem + ` and table_type in ('BASE TABLE', 'VIEW')
order by table_schema, table_name`
	mysqlColumns = `
select table_schema, table_name, column_name, column_type, is_nullable from information_schema.columns
where table_schema not in ` + mysqlSystem + `
order by table_schema, table_name, ordinal_position`
	mysqlKeys = `
select k.table_schema, k.table_name, k.constraint_name, c.constraint_type, k.column_name,
       k.referenced_table_schema, k.referenced_table_name, k.referenced_column_name
from information_schema.key_column_usage k
join information_schema.table_constraints c
  on c.constraint_schema = k.constraint_schema and c.constraint_name = k.constraint_name
 and c.table_schema = k.table_schema and c.table_name = k.table_name
where c.constraint_type in ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY') and k.table_schema not in ` + mysqlSystem + `
order by k.table_schema, k.table_name, k.constraint_name, k.ordinal_position`
)

const (
	sqlServerVersion = `select cast(serverproperty('ProductVersion') as nvarchar(128))`
	sqlServerTables  = `
select s.name, o.name,
       case when o.type = 'U' then (select sum(p.rows) from sys.partitions p where p.object_id = o.object_id and p.index_id in (0, 1)) end
from sys.objects o join sys.schemas s on s.schema_id = o.schema_id
where o.type in ('U', 'V') and o.is_ms_shipped = 0
order by s.name, o.name`
	sqlServerColumns = `
select s.name, o.name, c.name,
       case when ty.name in ('varchar', 'char', 'varbinary', 'binary')
              then ty.name + '(' + case when c.max_length = -1 then 'max' else cast(c.max_length as varchar(10)) end + ')'
            when ty.name in ('nvarchar', 'nchar')
              then ty.name + '(' + case when c.max_length = -1 then 'max' else cast(c.max_length / 2 as varchar(10)) end + ')'
            when ty.name in ('decimal', 'numeric')
              then ty.name + '(' + cast(c.precision as varchar(10)) + ',' + cast(c.scale as varchar(10)) + ')'
            else ty.name end,
       c.is_nullable
from sys.columns c
join sys.objects o on o.object_id = c.object_id join sys.schemas s on s.schema_id = o.schema_id
join sys.types ty on ty.user_type_id = c.user_type_id
where o.type in ('U', 'V') and o.is_ms_shipped = 0
order by s.name, o.name, c.column_id`
	sqlServerKeys = `
select s.name, t.name, i.name, case when i.is_primary_key = 1 then 'p' else 'u' end, c.name,
       cast(null as sysname), cast(null as sysname), cast(null as sysname), cast(ic.key_ordinal as int)
from sys.indexes i
join sys.tables t on t.object_id = i.object_id join sys.schemas s on s.schema_id = t.schema_id
join sys.index_columns ic on ic.object_id = i.object_id and ic.index_id = i.index_id and ic.key_ordinal > 0
join sys.columns c on c.object_id = ic.object_id and c.column_id = ic.column_id
where (i.is_primary_key = 1 or i.is_unique_constraint = 1) and t.is_ms_shipped = 0
union all
select s.name, t.name, fk.name, 'f', c.name, rs.name, rt.name, rc.name, cast(fkc.constraint_column_id as int)
from sys.foreign_keys fk
join sys.tables t on t.object_id = fk.parent_object_id join sys.schemas s on s.schema_id = t.schema_id
join sys.tables rt on rt.object_id = fk.referenced_object_id join sys.schemas rs on rs.schema_id = rt.schema_id
join sys.foreign_key_columns fkc on fkc.constraint_object_id = fk.object_id
join sys.columns c on c.object_id = fkc.parent_object_id and c.column_id = fkc.parent_column_id
join sys.columns rc on rc.object_id = fkc.referenced_object_id and rc.column_id = fkc.referenced_column_id
where t.is_ms_shipped = 0
order by 1, 2, 3, 9`
)

const oracleOwners = `(select username from all_users where oracle_maintained = 'N')`

const (
	oracleVersion = `select version from product_component_version where product like 'Oracle%' and rownum = 1`
	oracleTables  = `
select owner, table_name, num_rows from all_tables
where owner in ` + oracleOwners + ` and nested = 'NO' and secondary = 'N'
union all
select owner, view_name, null from all_views where owner in ` + oracleOwners + `
order by 1, 2`
	oracleColumns = `
select owner, table_name, column_name,
       data_type || case when data_type in ('VARCHAR2', 'NVARCHAR2', 'CHAR', 'NCHAR') then '(' || char_length || ')'
                         when data_type = 'RAW' then '(' || data_length || ')'
                         when data_type = 'NUMBER' and data_precision is not null then '(' || data_precision || ',' || nvl(data_scale, 0) || ')' end,
       case nullable when 'Y' then 1 else 0 end
from all_tab_columns where owner in ` + oracleOwners + `
order by owner, table_name, column_id`
	oracleKeys = `
select c.owner, c.table_name, c.constraint_name, lower(c.constraint_type), cc.column_name, r.owner, r.table_name, rc.column_name, cc.position
from all_constraints c
join all_cons_columns cc on cc.owner = c.owner and cc.constraint_name = c.constraint_name and cc.table_name = c.table_name
left join all_constraints r on r.owner = c.r_owner and r.constraint_name = c.r_constraint_name
left join all_cons_columns rc on rc.owner = r.owner and rc.constraint_name = r.constraint_name and rc.position = cc.position
where c.constraint_type in ('P', 'U', 'R') and c.owner in ` + oracleOwners + `
order by c.owner, c.table_name, c.constraint_name, cc.position`
)

// keyRow is one column of a key as the catalogues give it, a row per column in key order.
type keyRow struct {
	schema, table, name, kind, column       string
	targetSchema, targetTable, targetColumn *string
}

// keyKinds maps each catalogue's word for a key to Postgres's letter: MySQL's constraint types,
// SQL Server's letters as selected, Oracle's (r is a reference: a foreign key).
var keyKinds = map[string]string{
	"primary key": "p", "unique": "u", "foreign key": "f", "p": "p", "u": "u", "f": "f", "r": "f",
}

// keysOf groups key rows into keys: the kind letter (p, u, f; Oracle's r is f), columns in order.
func keysOf(c *catalogue, rows []keyRow) {
	for i := 0; i < len(rows); {
		first := rows[i]
		var columns, targets []string
		j := i
		for ; j < len(rows) && rows[j].schema == first.schema && rows[j].table == first.table && rows[j].name == first.name; j++ {
			columns = append(columns, rows[j].column)
			if rows[j].targetColumn != nil {
				targets = append(targets, *rows[j].targetColumn)
			}
		}
		kind, ok := keyKinds[first.kind]
		if ok {
			c.key(first.schema, first.table, kind, columns, first.targetSchema, first.targetTable, targets)
		}
		i = j
	}
}

// introspectMySQL reads one MySQL (or MariaDB) catalogue in a read-only transaction.
func introspectMySQL(ctx context.Context, dsn string) (Found, string) {
	u, err := url.Parse(dsn)
	if err != nil || u.User == nil {
		return Found{}, Error
	}
	ctx, cancel := context.WithTimeout(ctx, catalogueTimeout)
	defer cancel()
	password, _ := u.User.Password()
	host, port := u.Hostname(), u.Port()
	if port == "" {
		port = "3306"
	}
	mode := u.Query().Get("sslmode")
	dialer := func(ctx context.Context, network, address string) (net.Conn, error) {
		return (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, address)
	}
	attempt := func(useTLS bool) (*client.Conn, error) {
		var options []client.Option
		if useTLS {
			options = append(options, func(c *client.Conn) error {
				c.SetTLSConfig(&tls.Config{ServerName: host, MinVersion: tls.VersionTLS12, InsecureSkipVerify: mode != "verify-full"})
				return nil
			})
		}
		return client.ConnectWithDialer(ctx, "tcp", net.JoinHostPort(host, port), u.User.Username(), password, "", dialer, options...)
	}
	conn, err := attempt(mode != "disable")
	if err != nil && (mode == "" || mode == "prefer") && strings.Contains(err.Error(), "does not support TLS") {
		conn, err = attempt(false)
	}
	if err != nil {
		return Found{}, outcomeOfSQL(err)
	}
	defer conn.Close()
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	run := func(text string) (*mysql.Result, error) { return conn.Execute(text) }
	// MySQL 8 caches table statistics for a day; this session reads them as they stand (MariaDB has no such cache).
	_, _ = run("set session information_schema_stats_expiry = 0")
	version, err := run(mysqlVersion)
	if err != nil {
		return Found{}, outcomeOfSQL(err)
	}
	if _, err := run("start transaction read only"); err != nil {
		return Found{}, outcomeOfSQL(err)
	}
	defer func() { _, _ = run("rollback") }()
	c := newCatalogue()
	str := func(r *mysql.Result, row, col int) string {
		s, _ := r.GetString(row, col)
		return s
	}
	optStr := func(r *mysql.Result, row, col int) *string {
		if null, _ := r.IsNull(row, col); null {
			return nil
		}
		s := str(r, row, col)
		return &s
	}
	tables, err := run(mysqlTables)
	if err != nil {
		return Found{}, outcomeOfSQL(err)
	}
	for i := 0; i < tables.RowNumber(); i++ {
		var count *int64
		if null, _ := tables.IsNull(i, 2); !null {
			if n, err := tables.GetUint(i, 2); err == nil {
				v := int64(n)
				count = &v
			}
		}
		c.table(str(tables, i, 0), str(tables, i, 1), count)
	}
	columns, err := run(mysqlColumns)
	if err != nil {
		return Found{}, outcomeOfSQL(err)
	}
	for i := 0; i < columns.RowNumber(); i++ {
		c.column(str(columns, i, 0), str(columns, i, 1), str(columns, i, 2), str(columns, i, 3), str(columns, i, 4) == "YES")
	}
	keys, err := run(mysqlKeys)
	if err != nil {
		return Found{}, outcomeOfSQL(err)
	}
	rows := make([]keyRow, 0, keys.RowNumber())
	for i := 0; i < keys.RowNumber(); i++ {
		rows = append(rows, keyRow{schema: str(keys, i, 0), table: str(keys, i, 1), name: str(keys, i, 2), kind: strings.ToLower(str(keys, i, 3)),
			column: str(keys, i, 4), targetSchema: optStr(keys, i, 5), targetTable: optStr(keys, i, 6), targetColumn: optStr(keys, i, 7)})
	}
	keysOf(c, rows)
	product := "MySQL"
	v := str(version, 0, 0)
	if strings.Contains(strings.ToLower(v), "mariadb") {
		product = "MariaDB"
	}
	return c.found(portOf(u, 3306), product, firstWord(strings.SplitN(v, "-", 2)[0]), "mysql"), Identified
}

// introspectDatabaseSQL reads SQL Server's or Oracle's catalogue over database/sql.
func introspectDatabaseSQL(ctx context.Context, dialect string, u *url.URL, connector func() (*sql.DB, error)) (Found, string) {
	ctx, cancel := context.WithTimeout(ctx, catalogueTimeout)
	defer cancel()
	db, err := connector()
	if err != nil {
		return Found{}, Error
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	conn, err := db.Conn(ctx)
	if err != nil {
		return Found{}, outcomeOfSQL(err)
	}
	defer conn.Close()
	statements := map[string][4]string{
		"sqlserver": {sqlServerVersion, sqlServerTables, sqlServerColumns, sqlServerKeys},
		"oracle":    {oracleVersion, oracleTables, oracleColumns, oracleKeys},
	}[dialect]
	var version sql.NullString
	if err := conn.QueryRowContext(ctx, statements[0]).Scan(&version); err != nil && dialect != "oracle" {
		// Oracle's version view may be withheld from a narrow login; the catalogue is still read.
		return Found{}, outcomeOfSQL(err)
	}
	var tx *sql.Tx
	if dialect == "oracle" {
		// The driver takes no read-only option; Oracle's own statement opens the transaction read-only, or nothing is read.
		tx, err = conn.BeginTx(ctx, nil)
		if err == nil {
			if _, err = tx.ExecContext(ctx, "set transaction read only"); err != nil {
				_ = tx.Rollback()
			}
		}
	} else {
		tx, err = conn.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	}
	if err != nil {
		return Found{}, outcomeOfSQL(err)
	}
	// Always rolled back: a read keeps nothing.
	defer func() { _ = tx.Rollback() }()
	c := newCatalogue()
	each := func(text string, scan func(rows *sql.Rows) error) error {
		rows, err := tx.QueryContext(ctx, text)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			if err := scan(rows); err != nil {
				return err
			}
		}
		return rows.Err()
	}
	err = each(statements[1], func(rows *sql.Rows) error {
		var schema, name string
		var count sql.NullInt64
		if err := rows.Scan(&schema, &name, &count); err != nil {
			return err
		}
		var n *int64
		if count.Valid {
			n = &count.Int64
		}
		c.table(schema, name, n)
		return nil
	})
	if err != nil {
		return Found{}, outcomeOfSQL(err)
	}
	err = each(statements[2], func(rows *sql.Rows) error {
		var schema, name, column string
		var typ sql.NullString
		var nullable bool
		if err := rows.Scan(&schema, &name, &column, &typ, &nullable); err != nil {
			return err
		}
		c.column(schema, name, column, strings.ToLower(typ.String), nullable)
		return nil
	})
	if err != nil {
		return Found{}, outcomeOfSQL(err)
	}
	var keys []keyRow
	err = each(statements[3], func(rows *sql.Rows) error {
		var k keyRow
		var targetSchema, targetTable, targetColumn sql.NullString
		var position int64
		if err := rows.Scan(&k.schema, &k.table, &k.name, &k.kind, &k.column, &targetSchema, &targetTable, &targetColumn, &position); err != nil {
			return err
		}
		if targetTable.Valid {
			k.targetSchema, k.targetTable, k.targetColumn = &targetSchema.String, &targetTable.String, &targetColumn.String
		}
		keys = append(keys, k)
		return nil
	})
	if err != nil {
		return Found{}, outcomeOfSQL(err)
	}
	keysOf(c, keys)
	if dialect == "oracle" {
		return c.found(portOf(u, 1521), "Oracle Database", version.String, "oracle"), Identified
	}
	return c.found(portOf(u, 1433), "Microsoft SQL Server", version.String, "sqlserver"), Identified
}

func introspectSQLServer(ctx context.Context, dsn string) (Found, string) {
	u, err := url.Parse(dsn)
	if err != nil {
		return Found{}, Error
	}
	return introspectDatabaseSQL(ctx, "sqlserver", u, func() (*sql.DB, error) {
		connector, err := mssql.NewConnector(dsn)
		if err != nil {
			return nil, err
		}
		return sql.OpenDB(connector), nil
	})
}

func introspectOracle(ctx context.Context, dsn string) (Found, string) {
	u, err := url.Parse(dsn)
	if err != nil {
		return Found{}, Error
	}
	return introspectDatabaseSQL(ctx, "oracle", u, func() (*sql.DB, error) { return sql.OpenDB(go_ora.NewConnector(dsn)), nil })
}

// outcomeOfSQL names how MySQL, SQL Server or Oracle turned the agent away: credentials or
// privileges refused, unreachable, or anything else.
func outcomeOfSQL(err error) string {
	var my *mysql.MyError
	if errors.As(err, &my) && (my.Code == 1045 || my.Code == 1044 || my.Code == 1142 || my.Code == 1143 || my.Code == 1227) {
		return Refused
	}
	var ms mssql.Error
	if errors.As(err, &ms) && (ms.Number == 18456 || ms.Number == 229 || ms.Number == 230 || ms.Number == 297 || ms.Number == 300 || ms.Number == 4060) {
		return Refused
	}
	var ora *network.OracleError
	if errors.As(err, &ora) && (ora.ErrCode == 1017 || ora.ErrCode == 1031 || ora.ErrCode == 1045 || ora.ErrCode == 28000 || ora.ErrCode == 942) {
		return Refused
	}
	return outcomeOf(err)
}
