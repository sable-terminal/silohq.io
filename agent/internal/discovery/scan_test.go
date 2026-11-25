package discovery

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"net"
	"testing"
	"time"
)

const (
	org   = "01a1e000-0000-7000-8000-0000000000a1"
	agent = "01a1e000-0000-7000-8000-0000000000b2"
)

type signer struct {
	key ed25519.PrivateKey
	pem string
	id  string
}

func newSigner(t *testing.T) signer {
	t.Helper()
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(public)
	sum := sha256.Sum256(der)
	return signer{key: private, pem: string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})), id: base64.RawURLEncoding.EncodeToString(sum[:])}
}

func document(over func(a map[string]any)) string {
	a := map[string]any{
		"v": 1, "kind": "discovery_authorisation", "id": "01a1e000-0000-7000-8000-0000000000c3", "organisation_id": org, "agent_id": agent,
		"ranges": []string{"10.0.0.0/24"}, "methods": []string{"port_scan"}, "max_hosts": 50,
		"expires_at": time.Now().Add(time.Hour).UTC().Format(time.RFC3339Nano), "authorised_by": "01a1e000-0000-7000-8000-0000000000d4",
	}
	if over != nil {
		over(a)
	}
	raw, _ := json.Marshal(a)
	return string(raw)
}

func (s signer) scan(t *testing.T, doc string, over func(m map[string]any)) *Signed {
	t.Helper()
	sum := sha256.Sum256([]byte(doc))
	m := map[string]any{
		"version": 1, "scanId": "01a1e000-0000-7000-8000-0000000000e5", "organisationId": org, "agentId": agent,
		"authorisationId": "01a1e000-0000-7000-8000-0000000000c3", "authorisation": doc, "authorisationSha256": hex.EncodeToString(sum[:]),
		"issuedAt": time.Now().UTC().Format(time.RFC3339Nano), "startBy": time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339Nano),
	}
	if over != nil {
		over(m)
	}
	raw, _ := json.Marshal(m)
	signature := ed25519.Sign(s.key, append([]byte(Prefix+"\x00"), raw...))
	return &Signed{Scan: string(raw), KeyID: s.id, Signature: base64.RawURLEncoding.EncodeToString(signature)}
}

func TestOnlyAScanTheCellSignedForThisAgentRunsAndOnlyOnce(t *testing.T) {
	cell := newSigner(t)
	v, err := NewVerifier(cell.pem, org, agent)
	if err != nil {
		t.Fatal(err)
	}
	good := cell.scan(t, document(nil), nil)
	_, a, reason := v.Check(good)
	if reason != "" || a.MaxHosts != 50 || a.Ranges[0] != "10.0.0.0/24" {
		t.Fatalf("a good scan: %q %+v", reason, a)
	}
	if _, _, reason := v.Check(good); reason != "replayed" {
		t.Fatalf("a scan runs once: %q", reason)
	}

	other := newSigner(t)
	tampered := cell.scan(t, document(nil), func(m map[string]any) { m["scanId"] = "01a1e000-0000-7000-8000-0000000000f6" })
	tampered.Scan = tampered.Scan[:len(tampered.Scan)-1] + " }"
	cases := map[string]*Signed{
		"unsigned":    nil,
		"key_unknown": other.scan(t, document(nil), nil),
		"signature":   tampered,
		"agent":       cell.scan(t, document(nil), func(m map[string]any) { m["agentId"] = "01a1e000-0000-7000-8000-000000000999"; m["scanId"] = "s2" }),
		"organisation": cell.scan(t, document(nil), func(m map[string]any) {
			m["organisationId"] = "01a1e000-0000-7000-8000-000000000998"
			m["scanId"] = "s3"
		}),
		"expired": cell.scan(t, document(nil), func(m map[string]any) {
			m["startBy"] = time.Now().Add(-2 * time.Minute).UTC().Format(time.RFC3339Nano)
			m["scanId"] = "s4"
		}),
		// The approved document is not the one signed for: its hash does not match.
		"authorisation": cell.scan(t, document(nil), func(m map[string]any) {
			m["authorisation"] = document(func(a map[string]any) { a["ranges"] = []string{"10.0.0.0/16"} })
			m["scanId"] = "s5"
		}),
	}
	for want, signed := range cases {
		if _, _, reason := v.Check(signed); reason != want {
			t.Errorf("%s: refused as %q", want, reason)
		}
	}

	// The approved document holds the agent to its own bounds.
	for want, doc := range map[string]string{
		"agent":         document(func(a map[string]any) { a["agent_id"] = "01a1e000-0000-7000-8000-000000000997" }),
		"expired":       document(func(a map[string]any) { a["expires_at"] = time.Now().Add(-time.Second).UTC().Format(time.RFC3339Nano) }),
		"authorisation": document(func(a map[string]any) { a["ranges"] = []string{"10.0.0.0/8"} }),
	} {
		signed := cell.scan(t, doc, func(m map[string]any) { m["scanId"] = "doc-" + want })
		if _, _, reason := v.Check(signed); reason != want {
			t.Errorf("document %s: refused as %q", want, reason)
		}
	}
	unknownMethod := cell.scan(t, document(func(a map[string]any) { a["methods"] = []string{"exploit"} }), func(m map[string]any) { m["scanId"] = "m1" })
	if _, _, reason := v.Check(unknownMethod); reason != "authorisation" {
		t.Errorf("an unknown method: %q", reason)
	}

	// Without a key, nothing runs.
	none, _ := NewVerifier("", org, agent)
	if _, _, reason := none.Check(cell.scan(t, document(nil), func(m map[string]any) { m["scanId"] = "n1" })); reason != "unsigned" {
		t.Fatalf("no key: %q", reason)
	}
}

func TestTargetsAreExplicitAndEnumeratedWithoutInference(t *testing.T) {
	if _, err := ParseTargets([]string{"10.0.0.0/8"}); err == nil {
		t.Fatal("wider than /16 is refused")
	}
	for _, bad := range []string{"", "::1", "2001:db8::/64", "a b", "10.0.0.0/33", "123.45"} {
		if _, err := ParseTargets([]string{bad}); err == nil {
			t.Errorf("%q is not a target", bad)
		}
	}
	targets, err := ParseTargets([]string{"DB1.Example", "192.168.1.0/30", "10.9.8.7"})
	if err != nil {
		t.Fatal(err)
	}
	var hosts []string
	targets.Each(context.Background(), func(h string) bool { hosts = append(hosts, h); return true })
	want := []string{"db1.example", "192.168.1.1", "192.168.1.2", "10.9.8.7"}
	if len(hosts) != len(want) {
		t.Fatalf("hosts %v", hosts)
	}
	for i := range want {
		if hosts[i] != want[i] {
			t.Fatalf("hosts %v", hosts)
		}
	}
	if !targets.Contains("192.168.1.3") || targets.Contains("192.168.1.4") || targets.Contains("db2.example") {
		t.Fatal("containment as the cell checks it")
	}
	resolve := func(_ context.Context, host string) ([]net.IP, error) {
		return map[string][]net.IP{"app.internal": {net.ParseIP("192.168.1.2")}, "far.internal": {net.ParseIP("172.16.0.1")}}[host], nil
	}
	if h, ok := targets.Match(context.Background(), "app.internal", resolve); !ok || h != "192.168.1.2" {
		t.Fatalf("a name resolving into a range is reported by its address: %q %v", h, ok)
	}
	if _, ok := targets.Match(context.Background(), "far.internal", resolve); ok {
		t.Fatal("a name resolving outside is not reported")
	}
	if h, ok := targets.Match(context.Background(), "db1.example", resolve); !ok || h != "db1.example" {
		t.Fatal("a listed name is reported as listed")
	}
}
