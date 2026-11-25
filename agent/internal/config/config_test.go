package config

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func write(t *testing.T, body string, mode os.FileMode) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "agent.json")
	if err := os.WriteFile(path, []byte(body), mode); err != nil {
		t.Fatal(err)
	}
	return path
}

const good = `{"endpoint":"agent.uk-1.silohq.io:443","stateDir":"/var/lib/silo-agent","name":"plant-a",
  "connections":{"0190f4b2-0000-7000-8000-000000000001":{"dsn":"postgres://ro:secret@db:5432/erp"}}}`

func TestLoadsWithDefaults(t *testing.T) {
	c, err := Load(write(t, good, 0o600))
	if err != nil {
		t.Fatal(err)
	}
	if c.ServerName != "agent.uk-1.silohq.io" || c.HealthListen != "127.0.0.1:9440" || c.MaxConcurrentCalls != 32 || c.MemoryLimitMB != 512 {
		t.Fatalf("defaults: %+v", c)
	}
	dsn, known, err := c.DSN("0190f4b2-0000-7000-8000-000000000001")
	if err != nil || !known || dsn != "postgres://ro:secret@db:5432/erp" {
		t.Fatalf("dsn: %q %v %v", dsn, known, err)
	}
	if _, known, _ := c.DSN("other"); known {
		t.Fatal("a connection the file does not name is known")
	}
}

func TestRefusesAFileOthersMayRead(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix permissions")
	}
	if _, err := Load(write(t, good, 0o644)); err == nil || !strings.Contains(err.Error(), "chmod 600") {
		t.Fatalf("want a refusal naming chmod 600, got %v", err)
	}
}

func TestRefusesWhatTheAgentMustNotDo(t *testing.T) {
	cases := map[string]string{
		"listens beyond loopback": strings.Replace(good, `"name":"plant-a"`, `"name":"plant-a","healthListen":"0.0.0.0:9440"`, 1),
		"unknown field":           strings.Replace(good, `"name":"plant-a"`, `"name":"plant-a","listen":"0.0.0.0:443"`, 1),
		"no endpoint port":        strings.Replace(good, `agent.uk-1.silohq.io:443`, `agent.uk-1.silohq.io`, 1),
		"too many calls":          strings.Replace(good, `"name":"plant-a"`, `"name":"plant-a","maxConcurrentCalls":1000`, 1),
		"a relative file root":    strings.Replace(good, `"name":"plant-a"`, `"name":"plant-a","fileRoots":["exports"]`, 1),
		"the whole file system":   strings.Replace(good, `"name":"plant-a"`, `"name":"plant-a","fileRoots":["/"]`, 1),
	}
	for name, body := range cases {
		if _, err := Load(write(t, body, 0o600)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
}
