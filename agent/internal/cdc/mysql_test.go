package cdc

import (
	"testing"
	"time"

	"github.com/go-mysql-org/go-mysql/mysql"
	"github.com/go-mysql-org/go-mysql/replication"
)

func TestBinlogPositions(t *testing.T) {
	// A position is the file's number and the offset after an event: later files sort after earlier ones.
	if got := joined(4, 198).String(); got != "4/C6" {
		t.Fatalf("joined = %s", got)
	}
	seq, offset, err := split("4/C6")
	if err != nil || seq != 4 || offset != 198 {
		t.Fatalf("split = %d %d %v", seq, offset, err)
	}
	if !(joined(5, 4) > joined(4, 0xffffffff)) {
		t.Fatal("a later file is later whatever the offsets")
	}
	if base, n, ok := fileSeq("mysql-bin.000123"); !ok || base != "mysql-bin" || n != 123 {
		t.Fatalf("fileSeq = %q %d %v", base, n, ok)
	}
	if _, _, ok := fileSeq("nodot"); ok {
		t.Fatal("a name without a number is not a binary log file")
	}
}

func TestServerID(t *testing.T) {
	a, b := serverID("0195f0d2-0000-7000-8000-000000000001"), serverID("0195f0d2-0000-7000-8000-000000000002")
	if a == b || a != serverID("0195f0d2-0000-7000-8000-000000000001") {
		t.Fatal("stable per capture, different between captures")
	}
	if a < 0x40000000 || b < 0x40000000 {
		t.Fatal("clear of the small ids real replicas use")
	}
}

func TestLogin(t *testing.T) {
	m := &MySQL{DSN: "mysql://repl:s%40cret@db.example:3307/sales"}
	host, port, user, password, tlsConfig, prefer, err := m.login()
	if err != nil || host != "db.example" || port != 3307 || user != "repl" || password != "s@cret" || tlsConfig == nil || !prefer {
		t.Fatalf("login = %s %d %s %s %v %v %v", host, port, user, password, tlsConfig, prefer, err)
	}
	m.DSN = "mysql://repl:x@db.example?sslmode=disable"
	if _, port, _, _, tlsConfig, prefer, _ := m.login(); port != 3306 || tlsConfig != nil || prefer {
		t.Fatal("disable is plain, on the default port")
	}
	m.DSN = "mysql://repl:x@db.example?sslmode=verify-full"
	if _, _, _, _, tlsConfig, prefer, _ := m.login(); tlsConfig == nil || tlsConfig.InsecureSkipVerify || prefer {
		t.Fatal("verify-full checks the certificate and never falls back")
	}
	m.DSN = "postgres://repl:x@db.example/sales"
	if _, _, _, _, _, _, err := m.login(); err == nil {
		t.Fatal("only a mysql:// login reads a binary log")
	}
}

func TestBinlogValues(t *testing.T) {
	moment := time.Date(2026, 11, 1, 10, 0, 0, 250_000_000, time.FixedZone("x", 3600))
	cases := []struct {
		name      string
		kind      byte
		collation uint64
		in, want  any
	}{
		{"null", mysql.MYSQL_TYPE_LONG, 0, nil, nil},
		{"int", mysql.MYSQL_TYPE_LONG, 0, int32(-7), int64(-7)},
		{"unsigned beyond a double", mysql.MYSQL_TYPE_LONGLONG, 0, uint64(1<<53 + 1), "9007199254740993"},
		{"unsigned within", mysql.MYSQL_TYPE_LONGLONG, 0, uint64(42), int64(42)},
		{"decimal digits", mysql.MYSQL_TYPE_NEWDECIMAL, 0, "10.50", "10.50"},
		{"moment in UTC", mysql.MYSQL_TYPE_DATETIME2, 0, moment, "2026-11-01T09:00:00.250Z"},
		{"zero moment", mysql.MYSQL_TYPE_DATETIME2, 0, time.Time{}, nil},
		{"date", mysql.MYSQL_TYPE_DATE, 0, "2026-11-03", "2026-11-03"},
		{"zero date", mysql.MYSQL_TYPE_DATE, 0, "0000-00-00", nil},
		{"zero moment as logged", mysql.MYSQL_TYPE_DATETIME2, 0, "0000-00-00 00:00:00", nil},
		{"text", mysql.MYSQL_TYPE_VARCHAR, 255, "south", "south"},
		{"binary string", mysql.MYSQL_TYPE_VARCHAR, 63, "\xca\xfe", "\\xcafe"},
		{"blob", mysql.MYSQL_TYPE_BLOB, 63, []byte{0xca, 0xfe}, "\\xcafe"},
		{"text blob", mysql.MYSQL_TYPE_BLOB, 255, []byte("long text"), "long text"},
		{"json", mysql.MYSQL_TYPE_JSON, 0, []byte(`{"a":1}`), `{"a":1}`},
	}
	for _, c := range cases {
		got := binlogValue(c.kind, c.collation, c.in)
		if s, ok := got.(interface{ String() string }); ok {
			got = s.String()
		}
		if gotTime, ok := got.(time.Time); ok {
			got = gotTime.Format(time.RFC3339Nano)
		}
		if got != c.want {
			t.Errorf("%s: got %#v, want %#v", c.name, got, c.want)
		}
	}
}

func TestEnumAndSetLabels(t *testing.T) {
	labels := []string{"new", "paid", "shipped"}
	if got := enumLabel(labels, int64(2)); got != "paid" {
		t.Fatalf("enum = %v", got)
	}
	if got := enumLabel(labels, int64(0)); got != "" {
		t.Fatalf("an invalid value is stored as the empty label: %v", got)
	}
	if got := setLabels([]string{"a", "b", "c"}, int64(0b101)); got != "a,c" {
		t.Fatalf("set = %v", got)
	}
	if got := setLabels([]string{"a", "b"}, int64(0)); got != "" {
		t.Fatalf("empty set = %v", got)
	}
}

func TestRowsChanges(t *testing.T) {
	table := &replication.TableMapEvent{
		Schema: []byte("sales"), Table: []byte("orders"), ColumnCount: 3,
		ColumnType:     []byte{mysql.MYSQL_TYPE_LONG, mysql.MYSQL_TYPE_VARCHAR, mysql.MYSQL_TYPE_NEWDECIMAL},
		ColumnName:     [][]byte{[]byte("id"), []byte("region"), []byte("amount")},
		PrimaryKey:     []uint64{0},
		DefaultCharset: []uint64{255},
	}
	rows := &replication.RowsEvent{Table: table, Rows: [][]any{{int32(1), "south", "10.50"}, {int32(1), "north", "12.00"}}}
	updates := rowsChanges(replication.UPDATE_ROWS_EVENTv2, rows)
	if len(updates) != 1 || updates[0].Op != "update" || updates[0].Values["region"] != "north" || updates[0].Values["amount"] != "12.00" {
		t.Fatalf("an update carries its new image: %#v", updates)
	}
	deletes := rowsChanges(replication.DELETE_ROWS_EVENTv2, &replication.RowsEvent{Table: table, Rows: [][]any{{int32(7), "east", "1.00"}}})
	if len(deletes) != 1 || deletes[0].Op != "delete" || len(deletes[0].Values) != 1 || deletes[0].Values["id"] != int64(7) {
		t.Fatalf("a delete carries its key only: %#v", deletes)
	}
	inserts := rowsChanges(replication.WRITE_ROWS_EVENTv2, &replication.RowsEvent{Table: table, Rows: [][]any{{int32(8), "west", "2.00"}}})
	if len(inserts) != 1 || inserts[0].Schema != "sales" || inserts[0].Table != "orders" || len(inserts[0].Values) != 3 {
		t.Fatalf("an insert carries every column: %#v", inserts)
	}
}
