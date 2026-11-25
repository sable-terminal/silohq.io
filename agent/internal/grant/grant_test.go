package grant

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"testing"
	"time"
)

const (
	org        = "01a1e000-0000-7000-8000-00000000000a"
	connection = "01a1e000-0000-7000-8000-00000000000b"
)

type signer struct {
	key   ed25519.PrivateKey
	pem   string
	keyID string
}

func newSigner(t *testing.T) signer {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(public)
	sum := sha256.Sum256(der)
	return signer{key: private, pem: string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})), keyID: base64.RawURLEncoding.EncodeToString(sum[:])}
}

// sign makes a grant as the cell's actions does: Ed25519 over the prefix and the grant's JSON text.
func (s signer) sign(t *testing.T, statements []byte, change func(*Grant)) *Signed {
	sum := sha256.Sum256(statements)
	now := time.Now().UTC()
	g := Grant{Version: 1, GrantID: "01a1e000-0000-7000-8000-0000000000" + hex.EncodeToString([]byte{byte(now.UnixNano())}), OrganisationID: org,
		ActionID: "01a1e000-0000-7000-8000-00000000000c", ActionKind: "mutation", ConnectionID: connection, Object: "orders", Statements: 1,
		PayloadSHA256: hex.EncodeToString(sum[:]), IssuedAt: now, ExpiresAt: now.Add(5 * time.Minute)}
	if change != nil {
		change(&g)
	}
	text, _ := json.Marshal(g)
	signature := ed25519.Sign(s.key, append([]byte(Prefix+"\x00"), text...))
	return &Signed{Grant: string(text), KeyID: s.keyID, Signature: base64.RawURLEncoding.EncodeToString(signature)}
}

func TestAGrantCoversExactlyWhatWasSignedAndRunsOnce(t *testing.T) {
	s := newSigner(t)
	v, err := NewVerifier(s.pem, org)
	if err != nil {
		t.Fatal(err)
	}
	statements := []byte(`[{"text":"update sales.orders set status = $1 where id = $2","values":["shipped",1],"expectRows":1}]`)
	grant := s.sign(t, statements, nil)
	if _, reason := v.Check(grant, connection, statements, 1); reason != "" {
		t.Fatalf("a good grant: %s", reason)
	}
	if _, reason := v.Check(grant, connection, statements, 1); reason != "replayed" {
		t.Fatalf("a second use: %q", reason)
	}

	cases := map[string]struct {
		signed     *Signed
		connection string
		statements []byte
		count      int
	}{
		"unsigned":     {nil, connection, statements, 1},
		"payload":      {s.sign(t, statements, nil), connection, []byte(`[{"text":"delete from sales.orders","values":[]}]`), 1},
		"connection":   {s.sign(t, statements, nil), "01a1e000-0000-7000-8000-00000000000d", statements, 1},
		"statements":   {s.sign(t, statements, nil), connection, statements, 2},
		"expired":      {s.sign(t, statements, func(g *Grant) { g.ExpiresAt = time.Now().Add(-time.Second) }), connection, statements, 1},
		"organisation": {s.sign(t, statements, func(g *Grant) { g.OrganisationID = "01a1e000-0000-7000-8000-00000000000e" }), connection, statements, 1},
	}
	for want, c := range cases {
		if _, reason := v.Check(c.signed, c.connection, c.statements, c.count); reason != want {
			t.Errorf("%s: got %q", want, reason)
		}
	}

	// A signature by another key, or over other text, does not hold.
	other := newSigner(t).sign(t, statements, nil)
	if _, reason := v.Check(other, connection, statements, 1); reason != "key_unknown" {
		t.Errorf("another key: %q", reason)
	}
	tampered := s.sign(t, statements, nil)
	tampered.Grant = tampered.Grant[:len(tampered.Grant)-1] + " }"
	if _, reason := v.Check(tampered, connection, statements, 1); reason != "signature" {
		t.Errorf("tampered text: %q", reason)
	}
	// Without the cell's key, nothing is signed.
	bare, _ := NewVerifier("", org)
	if _, reason := bare.Check(s.sign(t, statements, nil), connection, statements, 1); reason != "unsigned" {
		t.Errorf("no key: %q", reason)
	}
}
