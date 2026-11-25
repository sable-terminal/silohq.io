package discovery

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/go-mysql-org/go-mysql/client"
	mssql "github.com/microsoft/go-mssqldb"
	go_ora "github.com/sijms/go-ora/v2"
)

// The sources profile of app/server's docker-compose (npm run sources:up): MySQL 53306, SQL
// Server 51433, Oracle 51521. A source that is not up skips its test.

// introspected runs a catalogue scan over one held connection and gives its probes and the schema named.
func introspected(t *testing.T, ctx context.Context, dsn, schema string) ([]Probe, Schema, []byte) {
	t.Helper()
	f := &frames{}
	err := Run(ctx, Settings{Databases: func() map[string]string { return map[string]string{"c1": dsn} }},
		authorisation([]string{"127.0.0.1"}, []string{MethodCatalogue}, 10), f.emit)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(f.all)
	for _, finding := range f.findings() {
		for _, s := range finding.Found.Schemas {
			if strings.EqualFold(s.Name, schema) {
				return f.probes(), s, raw
			}
		}
	}
	t.Fatalf("no schema %s among the findings; probes %+v", schema, f.probes())
	return nil, Schema{}, nil
}

func tablesOf(s Schema) map[string]Table {
	out := map[string]Table{}
	for _, table := range s.Tables {
		out[strings.ToLower(table.Name)] = table
	}
	return out
}

func checkStructure(t *testing.T, tables map[string]Table, integer, text string, raw []byte) {
	t.Helper()
	customers, orders := tables["customers"], tables["orders"]
	if len(tables) != 3 || len(customers.Columns) != 3 || !strings.HasPrefix(customers.Columns[0].Type, integer) ||
		!strings.HasPrefix(customers.Columns[1].Type, text) || customers.Columns[1].Nullable || !customers.Columns[2].Nullable {
		t.Fatalf("tables %+v", tables)
	}
	if !strings.EqualFold(strings.Join(customers.PrimaryKey, ","), "id") || len(customers.UniqueKeys) != 1 || !strings.EqualFold(customers.UniqueKeys[0][0], "email") {
		t.Fatalf("customers %+v", customers)
	}
	if len(orders.ForeignKeys) != 1 || !strings.EqualFold(orders.ForeignKeys[0].TargetTable, "customers") || !strings.EqualFold(orders.ForeignKeys[0].Columns[0], "customer_id") ||
		!strings.EqualFold(orders.ForeignKeys[0].TargetColumns[0], "id") || !strings.Contains(orders.Columns[2].Type, "12,2") {
		t.Fatalf("orders %+v", orders)
	}
	if tables["big_orders"].RowCount != nil {
		t.Fatalf("a view has no row count: %+v", tables["big_orders"])
	}
	if strings.Contains(string(raw), "private-person") || strings.Contains(string(raw), "Private Person") {
		t.Fatal("a row's value left the database")
	}
}

func TestMySQLCatalogueIsReadForStructureOnly(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	admin, err := client.Connect("127.0.0.1:53306", "root", "local", "")
	if err != nil {
		t.Skip("no MySQL here:", err)
	}
	defer admin.Close()
	db := fmt.Sprintf("catalogue_test_%d", os.Getpid())
	for _, statement := range []string{
		"drop database if exists " + db, "create database " + db, "use " + db,
		"create table customers (id int primary key, email varchar(200) not null unique, name varchar(100))",
		"create table orders (id bigint primary key, customer_id int not null, total decimal(12,2), foreign key (customer_id) references customers (id))",
		"create view big_orders as select id, total from orders where total > 100",
		"insert into customers values (1, 'private-person@example.com', 'Private Person')",
		"analyze table customers",
	} {
		if _, err := admin.Execute(statement); err != nil {
			t.Fatal(statement, err)
		}
	}
	defer func() { _, _ = admin.Execute("drop database if exists " + db) }()

	probes, schema, raw := introspected(t, ctx, "mysql://root:local@127.0.0.1:53306/"+db+"?sslmode=disable", db)
	if len(probes) != 1 || probes[0].Outcome != Identified || probes[0].Method != MethodCatalogue || probes[0].Port == nil || *probes[0].Port != 53306 {
		t.Fatalf("probes %+v", probes)
	}
	tables := tablesOf(schema)
	checkStructure(t, tables, "int", "varchar(200)", raw)
	if c := tables["customers"].RowCount; c == nil || *c != 1 {
		t.Fatalf("customers' row count is the engine's estimate: %v", c)
	}

	f := &frames{}
	if err := Run(ctx, Settings{Databases: func() map[string]string {
		return map[string]string{"c1": "mysql://root:not-the-password@127.0.0.1:53306/" + db + "?sslmode=disable"}
	}}, authorisation([]string{"127.0.0.1"}, []string{MethodCatalogue}, 10), f.emit); err != nil {
		t.Fatal(err)
	}
	if p := f.probes(); len(p) != 1 || p[0].Outcome != Refused || len(f.findings()) != 0 {
		t.Fatalf("a refused login: %+v", p)
	}
}

func TestSQLServerCatalogueIsReadForStructureOnly(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	const server = "sqlserver://sa:Local-Passw0rd!@127.0.0.1:51433?encrypt=disable"
	connector, err := mssql.NewConnector(server + "&database=master")
	if err != nil {
		t.Fatal(err)
	}
	admin := sql.OpenDB(connector)
	defer admin.Close()
	if err := admin.PingContext(ctx); err != nil {
		t.Skip("no SQL Server here:", err)
	}
	db := fmt.Sprintf("catalogue_test_%d", os.Getpid())
	drop := "if db_id('" + db + "') is not null begin alter database " + db + " set single_user with rollback immediate; drop database " + db + " end"
	for _, statement := range []string{drop, "create database " + db} {
		if _, err := admin.ExecContext(ctx, statement); err != nil {
			t.Fatal(statement, err)
		}
	}
	defer func() { _, _ = admin.ExecContext(context.Background(), drop) }()
	inDB, err := mssql.NewConnector(server + "&database=" + db)
	if err != nil {
		t.Fatal(err)
	}
	source := sql.OpenDB(inDB)
	for _, statement := range []string{
		"create schema sales",
		"create table sales.customers (id int primary key, email varchar(200) not null unique, name varchar(100))",
		"create table sales.orders (id bigint primary key, customer_id int not null references sales.customers (id), total decimal(12,2))",
		"create view sales.big_orders as select id, total from sales.orders where total > 100",
		"insert into sales.customers values (1, 'private-person@example.com', 'Private Person')",
	} {
		if _, err := source.ExecContext(ctx, statement); err != nil {
			t.Fatal(statement, err)
		}
	}
	source.Close()

	probes, schema, raw := introspected(t, ctx, server+"&database="+db, "sales")
	if len(probes) != 1 || probes[0].Outcome != Identified || probes[0].Port == nil || *probes[0].Port != 51433 {
		t.Fatalf("probes %+v", probes)
	}
	tables := tablesOf(schema)
	checkStructure(t, tables, "int", "varchar(200)", raw)
	if c := tables["customers"].RowCount; c == nil || *c != 1 {
		t.Fatalf("customers' row count from sys.partitions: %v", c)
	}
}

func TestOracleCatalogueIsReadForStructureOnly(t *testing.T) {
	if conn, err := net.DialTimeout("tcp", "127.0.0.1:51521", time.Second); err != nil {
		t.Skip("no Oracle here:", err)
	} else {
		conn.Close()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	admin := sql.OpenDB(go_ora.NewConnector("oracle://system:local@127.0.0.1:51521/FREEPDB1"))
	defer admin.Close()
	if err := admin.PingContext(ctx); err != nil {
		t.Skip("Oracle is not answering:", err)
	}
	user := fmt.Sprintf("CATALOGUE_%d", os.Getpid())
	drop := "begin execute immediate 'drop user " + user + " cascade'; exception when others then null; end;"
	for _, statement := range []string{drop, "create user " + user + " identified by local quota unlimited on users", "grant create session, create table, create view to " + user} {
		if _, err := admin.ExecContext(ctx, statement); err != nil {
			t.Fatal(statement, err)
		}
	}
	defer func() { _, _ = admin.ExecContext(context.Background(), drop) }()
	source := sql.OpenDB(go_ora.NewConnector("oracle://" + user + ":local@127.0.0.1:51521/FREEPDB1"))
	for _, statement := range []string{
		"create table customers (id number(10) primary key, email varchar2(200) not null unique, name varchar2(100))",
		"create table orders (id number(19) primary key, customer_id number(10) not null references customers (id), total number(12,2))",
		"create view big_orders as select id, total from orders where total > 100",
		"insert into customers values (1, 'private-person@example.com', 'Private Person')",
		"begin dbms_stats.gather_table_stats(user, 'CUSTOMERS'); end;",
	} {
		if _, err := source.ExecContext(ctx, statement); err != nil {
			t.Fatal(statement, err)
		}
	}
	source.Close()

	probes, schema, raw := introspected(t, ctx, "oracle://"+user+":local@127.0.0.1:51521/FREEPDB1", user)
	if len(probes) != 1 || probes[0].Outcome != Identified || probes[0].Port == nil || *probes[0].Port != 51521 {
		t.Fatalf("probes %+v", probes)
	}
	tables := tablesOf(schema)
	checkStructure(t, tables, "number", "varchar2(200)", raw)
	if c := tables["customers"].RowCount; c == nil || *c != 1 {
		t.Fatalf("customers' row count from the gathered statistics: %v", c)
	}
}
