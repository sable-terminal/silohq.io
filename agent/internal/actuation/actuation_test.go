package actuation

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"fmt"
	"strings"
	"testing"

	"silohq.io/agent/internal/protocol"
	"silohq.io/agent/internal/signing"
)

const (
	org  = "0190f4a8-0000-7000-8000-0000000000a2"
	conn = "0190f4a8-0000-7000-8000-000000000001"
	node = "nsu=urn:silo:test:plant;s=Pump1.Motor.Speed"
)

type cellKey struct {
	private ed25519.PrivateKey
	pem     string
	id      string
}

func newCellKey(t *testing.T) cellKey {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(public)
	keyPEM := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	_, id, err := signing.ParsePublicKey(keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	return cellKey{private: private, pem: keyPEM, id: id}
}

// text is an entry as the cell's allowlistEntryText writes it: canonical JSON, keys sorted.
func text(id, organisation, connection, address string) string {
	return fmt.Sprintf(`{"added_by":"0190f4a8-0000-7000-8000-0000000000b1","approved_at":"2026-11-18T14:00:00.000Z",`+
		`"approved_by":"0190f4a8-0000-7000-8000-0000000000b2","connection_id":%q,"data_type":"Int32","id":%q,`+
		`"inverse_command":null,"kind":"setpoint","max_step":"200","max_value":"1800.5","min_interval_seconds":30,"min_value":"0",`+
		`"node_address":%q,"object_id":"0190f4a8-0000-7000-8000-0000000000c1","organisation_id":%q,"purpose":"actuation_allowlist_entry",`+
		`"simulator_address":null,"transport":"opcua","v":1}`, connection, id, address, organisation)
}

func (k cellKey) sign(entry string) protocol.SignedEntry {
	message := append(append([]byte(Prefix), 0), entry...)
	return protocol.SignedEntry{Entry: entry, KeyID: k.id, Signature: base64.RawURLEncoding.EncodeToString(ed25519.Sign(k.private, message))}
}

func TestStore(t *testing.T) {
	key := newCellKey(t)
	store, err := NewStore(key.pem, org)
	if err != nil {
		t.Fatal(err)
	}
	good := key.sign(text("0190f4a8-0000-7000-8000-0000000000e1", org, conn, node))
	if reason := store.Replace(conn, []protocol.SignedEntry{good}); reason != "" {
		t.Fatalf("a signed list refused: %s", reason)
	}
	entry, ok := store.Lookup(conn, "opcua", node)
	if !ok || entry.Kind != "setpoint" || *entry.MaxValue != "1800.5" || entry.MinIntervalSeconds != 30 {
		t.Fatalf("the entry: %#v %v", entry, ok)
	}
	if _, ok := store.Lookup(conn, "opcua", node+"X"); ok {
		t.Error("an unlisted node was found")
	}
	digests := store.Digests()
	if len(digests) != 1 || digests[0].Digest != Digest([]string{good.Signature}) {
		t.Errorf("digests: %#v", digests)
	}

	// Each of these refuses the whole list, and the one held stays.
	other := newCellKey(t)
	tampered := good
	tampered.Entry = strings.Replace(good.Entry, `"max_value":"1800.5"`, `"max_value":"9000"`, 1)
	for name, list := range map[string]struct {
		entries []protocol.SignedEntry
		want    string
	}{
		"another key":            {[]protocol.SignedEntry{other.sign(good.Entry)}, RefusedKey},
		"a changed entry":        {[]protocol.SignedEntry{tampered}, RefusedSignature},
		"another organisation":   {[]protocol.SignedEntry{key.sign(text("0190f4a8-0000-7000-8000-0000000000e2", "0190f4a8-0000-7000-8000-0000000000ff", conn, node))}, RefusedEntry},
		"another connection":     {[]protocol.SignedEntry{key.sign(text("0190f4a8-0000-7000-8000-0000000000e3", org, "0190f4a8-0000-7000-8000-0000000000fe", node))}, RefusedEntry},
		"one bad among the good": {[]protocol.SignedEntry{good, tampered}, RefusedSignature},
	} {
		if reason := store.Replace(conn, list.entries); reason != list.want {
			t.Errorf("%s: want %s, got %q", name, list.want, reason)
		}
		if _, ok := store.Lookup(conn, "opcua", node); !ok {
			t.Errorf("%s: the held list was lost", name)
		}
	}
	// An empty list ends the connection's.
	if reason := store.Replace(conn, nil); reason != "" {
		t.Fatal(reason)
	}
	if _, ok := store.Lookup(conn, "opcua", node); ok || len(store.Digests()) != 0 {
		t.Error("an emptied list still holds entries")
	}
	// Without a key, nothing is taken.
	keyless, _ := NewStore("", org)
	if reason := keyless.Replace(conn, []protocol.SignedEntry{good}); reason != RefusedNoKey {
		t.Errorf("keyless: %q", reason)
	}
}

// methodText is a method's entry with input arguments (D245), as the cell writes it: keys sorted.
func methodText(id, arguments string) string {
	return fmt.Sprintf(`{"added_by":"0190f4a8-0000-7000-8000-0000000000b1","approved_at":"2026-11-18T14:00:00.000Z",`+
		`"approved_by":"0190f4a8-0000-7000-8000-0000000000b2","arguments":%s,"connection_id":%q,"data_type":"Boolean","id":%q,`+
		`"inverse_command":null,"kind":"method","max_step":null,"max_value":null,"min_interval_seconds":0,"min_value":null,`+
		`"node_address":"nsu=urn:silo:test:plant;s=Pump1.Motor.Ramp","object_id":"0190f4a8-0000-7000-8000-0000000000c1","organisation_id":%q,`+
		`"purpose":"actuation_allowlist_entry","simulator_address":null,"transport":"opcua","v":1}`, arguments, conn, id, org)
}

func TestMethodArguments(t *testing.T) {
	key := newCellKey(t)
	store, err := NewStore(key.pem, org)
	if err != nil {
		t.Fatal(err)
	}
	good := `[{"data_type":"Int32","max_value":"1500","min_value":"0","name":"Rpm","values":null},` +
		`{"data_type":"String","max_value":null,"min_value":null,"name":"Mode","values":["auto","manual"]},` +
		`{"data_type":"Boolean","max_value":null,"min_value":null,"name":"Hold","values":null}]`
	if reason := store.Replace(conn, []protocol.SignedEntry{key.sign(methodText("0190f4a8-0000-7000-8000-0000000000e1", good))}); reason != "" {
		t.Fatalf("a method's bounded arguments: %s", reason)
	}
	e, ok := store.Lookup(conn, "opcua", "nsu=urn:silo:test:plant;s=Pump1.Motor.Ramp")
	if !ok || len(e.Arguments) != 3 || e.Arguments[1].Values[1] != "manual" || *e.Arguments[0].MaxValue != "1500" {
		t.Fatalf("read back: %+v", e.Arguments)
	}
	for name, arguments := range map[string]string{
		"a number without its range":    `[{"data_type":"Int32","max_value":null,"min_value":null,"name":"Rpm","values":null}]`,
		"text without its values":       `[{"data_type":"String","max_value":null,"min_value":null,"name":"Mode","values":null}]`,
		"a range turned round":          `[{"data_type":"Double","max_value":"1","min_value":"2","name":"Rate","values":null}]`,
		"a type not taken":              `[{"data_type":"DateTime","max_value":null,"min_value":null,"name":"At","values":null}]`,
		"a name twice":                  `[{"data_type":"Boolean","max_value":null,"min_value":null,"name":"On","values":null},{"data_type":"Boolean","max_value":null,"min_value":null,"name":"On","values":null}]`,
		"none at all":                   `[]`,
		"a Boolean with values to pick": `[{"data_type":"Boolean","max_value":null,"min_value":null,"name":"On","values":["true"]}]`,
	} {
		if reason := store.Replace(conn, []protocol.SignedEntry{key.sign(methodText("0190f4a8-0000-7000-8000-0000000000e2", arguments))}); reason != RefusedEntry {
			t.Errorf("%s: %q", name, reason)
		}
	}
	if _, ok := store.Lookup(conn, "opcua", "nsu=urn:silo:test:plant;s=Pump1.Motor.Ramp"); !ok {
		t.Error("a refused list leaves the one held")
	}
}
