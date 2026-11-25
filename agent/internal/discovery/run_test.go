package discovery

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

// frames collects what a scan reports.
type frames struct {
	mu  sync.Mutex
	all []any
}

func (f *frames) emit(frame any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.all = append(f.all, frame)
	return nil
}

func (f *frames) probes() []Probe {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Probe
	for _, x := range f.all {
		if p, ok := x.(Probe); ok {
			out = append(out, p)
		}
	}
	return out
}

func (f *frames) findings() []Finding {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Finding
	for _, x := range f.all {
		if p, ok := x.(Finding); ok {
			out = append(out, p)
		}
	}
	return out
}

func (f *frames) end(t *testing.T) End {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.all) == 0 {
		t.Fatal("nothing reported")
	}
	end, ok := f.all[len(f.all)-1].(End)
	if !ok {
		t.Fatalf("the last frame is not the end: %#v", f.all[len(f.all)-1])
	}
	return end
}

// listen answers each connection with answer, returning its port.
func listen(t *testing.T, answer func(net.Conn)) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() {
				defer c.Close()
				answer(c)
			}()
		}
	}()
	return l.Addr().(*net.TCPAddr).Port
}

func closedPort(t *testing.T) int {
	t.Helper()
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return port
}

func authorisation(ranges, methods []string, maxHosts int) Authorisation {
	return Authorisation{V: 1, Kind: "discovery_authorisation", Ranges: ranges, Methods: methods, MaxHosts: maxHosts, ExpiresAt: time.Now().Add(time.Minute)}
}

func TestAPortScanReportsEveryProbeAndRecognisesWhatAnswers(t *testing.T) {
	// A Postgres server answers the SSL request with N; an SSH server greets; a silent one says nothing.
	postgres := listen(t, func(c net.Conn) {
		buf := make([]byte, 8)
		if _, err := c.Read(buf); err == nil {
			_, _ = c.Write([]byte("N"))
		}
	})
	ssh := listen(t, func(c net.Conn) {
		_, _ = c.Write([]byte("SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13\r\n"))
		time.Sleep(time.Second)
	})
	mysql := listen(t, func(c net.Conn) {
		greeting := append([]byte{0, 0, 0, 0, 0x0a}, []byte("8.0.36\x00more")...)
		greeting[0] = byte(len(greeting) - 4)
		_, _ = c.Write(greeting)
		time.Sleep(time.Second)
	})
	silent := listen(t, func(c net.Conn) {
		buf := make([]byte, 64)
		_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
		_, _ = c.Read(buf)
	})
	closed := closedPort(t)

	f := &frames{}
	ports := []int{postgres, ssh, mysql, silent, closed}
	err := Run(context.Background(), Settings{Ports: ports}, authorisation([]string{"127.0.0.1"}, []string{MethodPortScan, MethodOPCUA}, 10), f.emit)
	if err != nil {
		t.Fatal(err)
	}
	outcomes := map[int]string{}
	for _, p := range f.probes() {
		if p.Host != "127.0.0.1" || p.Method != MethodPortScan || p.Port == nil || p.ProbedAt.IsZero() {
			t.Fatalf("probe %+v", p)
		}
		outcomes[*p.Port] = p.Outcome
	}
	want := map[int]string{postgres: Identified, ssh: Identified, mysql: Identified, silent: Open, closed: Closed}
	for port, outcome := range want {
		if outcomes[port] != outcome {
			t.Errorf("port %d: %q, want %q", port, outcomes[port], outcome)
		}
	}
	products := map[int]string{}
	for _, finding := range f.findings() {
		name := ""
		if finding.Found.Product != nil {
			name = *finding.Found.Product
			if finding.Found.Version != nil {
				name += " " + *finding.Found.Version
			}
		}
		products[*finding.Found.Port] = name + "|" + finding.Found.Protocol
	}
	if products[postgres] != "PostgreSQL|sql" || products[ssh] != "OpenSSH 9.6p1|sftp" || products[mysql] != "MySQL 8.0.36|sql" || products[silent] != "|other" {
		t.Fatalf("findings %v", products)
	}
	if _, ok := products[closed]; ok {
		t.Fatal("a closed port is a probe, not a finding")
	}
	if end := f.end(t); end.Status != "completed" || len(end.Unavailable) != 1 || end.Unavailable[0] != MethodOPCUA {
		t.Fatalf("end %+v", end)
	}
}

func TestTheHostBoundAndTheRateHold(t *testing.T) {
	port := listen(t, func(net.Conn) {})
	f := &frames{}
	started := time.Now()
	// Three hosts named, two allowed, at four a second: the third is never contacted.
	err := Run(context.Background(), Settings{Ports: []int{port}, HostsPerSecond: 4, Resolve: func(context.Context, string) ([]net.IP, error) { return nil, nil }},
		authorisation([]string{"127.0.0.1", "localhost", "127.0.0.2"}, []string{MethodPortScan}, 2), f.emit)
	if err != nil {
		t.Fatal(err)
	}
	hosts := map[string]bool{}
	for _, p := range f.probes() {
		hosts[p.Host] = true
	}
	if len(hosts) != 2 || hosts["127.0.0.2"] {
		t.Fatalf("hosts contacted %v", hosts)
	}
	if time.Since(started) < 200*time.Millisecond {
		t.Fatal("the second host waits its turn")
	}
	if end := f.end(t); end.Status != "completed" || end.Reason != "max_hosts" {
		t.Fatalf("end %+v", end)
	}
}

func TestAScanStopsWhenItsAuthorisationExpires(t *testing.T) {
	port := listen(t, func(net.Conn) {})
	f := &frames{}
	a := authorisation([]string{"192.0.2.0/24"}, []string{MethodPortScan}, 1000)
	a.ExpiresAt = time.Now().Add(300 * time.Millisecond)
	// TEST-NET addresses answer nothing: the scan is slow, and the window closes on it.
	err := Run(context.Background(), Settings{Ports: []int{port}, HostsPerSecond: 5, DialTimeout: 100 * time.Millisecond}, a, f.emit)
	if err != nil {
		t.Fatal(err)
	}
	if end := f.end(t); end.Status != "failed" || end.Reason != "authorisation_expired" {
		t.Fatalf("end %+v", end)
	}
	if n := len(f.probes()); n > 3 {
		t.Fatalf("%d hosts probed in 300ms at 5 a second", n)
	}
}

func TestHostConfigurationReportsOnlySystemsWithinTheTargetsAndNoCredentials(t *testing.T) {
	dir := t.TempDir()
	odbc := filepath.Join(dir, "odbc.ini")
	_ = os.WriteFile(odbc, []byte(`[Sales]
Driver=/opt/microsoft/msodbcsql18/lib64/libmsodbcsql-18.so
Server=tcp:sales-db.corp,1444
UID=report
PWD=secret-password-1
Database=SalesDb

[Outside]
Driver=PostgreSQL Unicode
Servername=far.corp
Port=5432
`), 0o600)
	jobs := filepath.Join(dir, "nightly.cron")
	_ = os.WriteFile(jobs, []byte(`0 2 * * * etl /usr/bin/load --source postgres://etl:secret-password-2@10.1.2.3:5433/warehouse --target https://api.corp/v1/load
30 2 * * * etl /usr/bin/push mqtt://broker.corp:1883/plant
`), 0o600)
	resolve := func(_ context.Context, host string) ([]net.IP, error) {
		return map[string][]net.IP{"broker.corp": {net.ParseIP("10.1.2.9")}, "far.corp": {net.ParseIP("172.16.0.4")}}[host], nil
	}
	f := &frames{}
	err := Run(context.Background(), Settings{ConfigPaths: []string{odbc, jobs}, Resolve: resolve},
		authorisation([]string{"sales-db.corp", "10.1.2.0/24"}, []string{MethodHostConfig}, 10), f.emit)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]string{}
	for _, finding := range f.findings() {
		got[fmt.Sprintf("%s:%d", finding.Host, *finding.Found.Port)] = *finding.Found.Product
	}
	want := map[string]string{"sales-db.corp:1444": "Microsoft SQL Server", "10.1.2.3:5433": "PostgreSQL", "10.1.2.9:1883": "MQTT broker"}
	if len(got) != len(want) {
		t.Fatalf("findings %v", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("findings %v", got)
		}
	}
	if len(f.probes()) != 3 {
		t.Fatalf("one probe per system reported: %d", len(f.probes()))
	}
	raw, _ := json.Marshal(f.all)
	for _, never := range []string{"secret-password", "report", "SalesDb", "warehouse", "etl", "far.corp", "api.corp"} {
		if strings.Contains(string(raw), never) {
			t.Fatalf("%q left the host: %s", never, raw)
		}
	}
}

func adminURL() string {
	if u := os.Getenv("CDC_TEST_ADMIN_URL"); u != "" {
		return u
	}
	return "postgres://postgres:postgres@127.0.0.1:55432/postgres?sslmode=disable"
}

func TestCatalogueIntrospectionReadsStructureOnlyFromHeldConnections(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	admin, err := pgx.Connect(ctx, adminURL())
	if err != nil {
		t.Skip("no Postgres here:", err)
	}
	defer admin.Close(context.Background())
	db := fmt.Sprintf("catalogue_test_%d", os.Getpid())
	_, _ = admin.Exec(ctx, "drop database if exists "+db+" with (force)")
	if _, err := admin.Exec(ctx, "create database "+db); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = admin.Exec(context.Background(), "drop database if exists "+db+" with (force)") }()
	u, _ := url.Parse(adminURL())
	u.Path = "/" + db
	source, err := pgx.Connect(ctx, u.String())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := source.Exec(ctx, `
		create schema sales;
		create table sales.customers (id integer primary key, email text not null unique, name text);
		create table sales.orders (id bigint primary key, customer_id integer not null references sales.customers (id), total numeric(12,2));
		create view sales.big_orders as select id, total from sales.orders where total > 100;
		insert into sales.customers values (1, 'private-person@example.com', 'Private Person');
		analyze sales.customers;`); err != nil {
		t.Fatal(err)
	}
	source.Close(ctx)

	wrong := *u
	wrong.User = url.UserPassword("postgres", "not-the-password")
	f := &frames{}
	err = Run(ctx, Settings{Databases: func() map[string]string {
		return map[string]string{"c1": u.String(), "c2": wrong.String(), "c3": "postgres://x:y@203.0.113.9:5432/elsewhere"}
	}}, authorisation([]string{u.Hostname()}, []string{MethodCatalogue}, 10), f.emit)
	if err != nil {
		t.Fatal(err)
	}
	probes := f.probes()
	if len(probes) != 2 || probes[0].Outcome != Identified || probes[1].Outcome != Refused || probes[0].Method != MethodCatalogue {
		t.Fatalf("probes %+v (the connection outside the targets is never opened)", probes)
	}
	findings := f.findings()
	if len(findings) != 1 {
		t.Fatalf("findings %d", len(findings))
	}
	found := findings[0].Found
	if *found.Product != "PostgreSQL" || found.Version == nil || *found.Dialect != "postgres" || len(found.Schemas) != 1 || found.Schemas[0].Name != "sales" {
		t.Fatalf("found %+v", found)
	}
	tables := map[string]Table{}
	for _, table := range found.Schemas[0].Tables {
		tables[table.Name] = table
	}
	customers, orders := tables["customers"], tables["orders"]
	if len(tables) != 3 || len(customers.Columns) != 3 || customers.Columns[1].Type != "text" || customers.Columns[1].Nullable || !customers.Columns[2].Nullable {
		t.Fatalf("tables %+v", tables)
	}
	if strings.Join(customers.PrimaryKey, ",") != "id" || len(customers.UniqueKeys) != 1 || customers.UniqueKeys[0][0] != "email" ||
		customers.RowCount == nil || *customers.RowCount != 1 {
		t.Fatalf("customers %+v", customers)
	}
	if len(orders.ForeignKeys) != 1 || orders.ForeignKeys[0].TargetTable != "customers" || orders.ForeignKeys[0].Columns[0] != "customer_id" ||
		orders.Columns[2].Type != "numeric(12,2)" {
		t.Fatalf("orders %+v", orders)
	}
	raw, _ := json.Marshal(f.all)
	if strings.Contains(string(raw), "private-person") || strings.Contains(string(raw), "Private Person") {
		t.Fatal("a row's value left the database")
	}
}
