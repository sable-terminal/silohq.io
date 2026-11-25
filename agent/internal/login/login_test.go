package login

import (
	"context"
	"crypto/ecdh"
	"crypto/hpke"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"errors"
	"fmt"
	"net/netip"
	"testing"
	"time"

	"silohq.io/agent/internal/protocol"
)

const (
	agentID = "0190f4a8-0000-7000-8000-00000000000a"
	orgID   = "0190f4a8-0000-7000-8000-00000000000b"
	connID  = "0190f4a8-0000-7000-8000-00000000000c"
	workID  = "0190f4a8-0000-7000-8000-00000000000d"
)

func newKey(t *testing.T) *ecdh.PrivateKey {
	key, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return key
}

// seal does what the cell's credential service does (app/server: sealForAgent).
func seal(t *testing.T, to *ecdh.PublicKey, info string, document string, expires time.Time) *protocol.SealedLogin {
	pub, err := hpke.DHKEM(ecdh.X25519()).NewPublicKey(to.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := hpke.Seal(pub, hpke.HKDFSHA256(), hpke.AES256GCM(), []byte(info), []byte(document))
	if err != nil {
		t.Fatal(err)
	}
	return &protocol.SealedLogin{Sealed: base64.StdEncoding.EncodeToString(sealed), ExpiresAt: expires}
}

func info(agent, connection, work string) string {
	return fmt.Sprintf("%s\x00{\"agentId\":%q,\"connectionId\":%q,\"organisationId\":%q,\"workId\":%q}", Info, agent, connection, orgID, work)
}

func document(expires time.Time, password string) string {
	return fmt.Sprintf(`{"expiresAt":%q,"params":{"database":"erp","host":"db.corp.example","port":"5433","sslmode":"require"},"username":"reader","password":%s}`,
		expires.Format(time.RFC3339Nano), password)
}

func TestOpen(t *testing.T) {
	key := newKey(t)
	opener, err := NewOpener(agentID, orgID, key.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	expires := now.Add(2 * time.Minute)
	good := seal(t, key.PublicKey(), info(agentID, connID, workID), document(expires, `"päss\"w\\o\nrd😀"`), expires)
	login, reason := opener.Open(good, connID, workID, now)
	if reason != "" {
		t.Fatalf("a good login refused: %s", reason)
	}
	if login.Host != "db.corp.example" || login.Port != "5433" || login.Database != "erp" || login.SSLMode != "require" || login.User != "reader" {
		t.Fatalf("the login read wrong: %+v", login)
	}
	if string(login.Password.Bytes()) != "päss\"w\\o\nrd😀" {
		t.Fatalf("the password unescaped wrong: %q", login.Password.Bytes())
	}
	held := login.Password.Bytes()
	if !login.Password.Locked() && !Unlocked() {
		t.Fatal("an unlocked password went unnoticed")
	}
	login.Zero()
	if login.Password.Bytes() != nil {
		t.Fatal("the password's pages were not given back")
	}
	_ = held // its pages are unmapped: reading them now would fault, which is the point
	login.Zero()

	cases := map[string]struct {
		sealed     *protocol.SealedLogin
		connection string
		work       string
		at         time.Time
		reason     string
	}{
		"for another piece of work":   {good, connID, "0190f4a8-0000-7000-8000-0000000000ff", now, RefusedSealing},
		"for another connection":      {good, "0190f4a8-0000-7000-8000-0000000000ee", workID, now, RefusedSealing},
		"for another agent":           {seal(t, key.PublicKey(), info("0190f4a8-0000-7000-8000-0000000000dd", connID, workID), document(expires, `"x"`), expires), connID, workID, now, RefusedSealing},
		"to another key":              {seal(t, newKey(t).PublicKey(), info(agentID, connID, workID), document(expires, `"x"`), expires), connID, workID, now, RefusedSealing},
		"after its expiry":            {good, connID, workID, expires, RefusedExpired},
		"expired inside, not outside": {seal(t, key.PublicKey(), info(agentID, connID, workID), document(now.Add(-time.Second), `"x"`), expires), connID, workID, now, RefusedExpired},
		"none":                        {nil, connID, workID, now, RefusedSealing},
	}
	// An industrial login (MQTT, OPC UA) names no address: it opens, and a database refuses it
	// where it is opened (work.SQL.open).
	addressless := seal(t, key.PublicKey(), info(agentID, connID, workID), fmt.Sprintf(`{"expiresAt":%q,"params":{},"password":"x"}`, expires.Format(time.RFC3339Nano)), expires)
	if l, reason := opener.Open(addressless, connID, workID, now); reason != "" || l.Host != "" || l.Database != "" {
		t.Errorf("no address: got %q, want an opened login without an address", reason)
	} else {
		l.Zero()
	}
	for name, c := range cases {
		if _, reason := opener.Open(c.sealed, c.connection, c.work, c.at); reason != c.reason {
			t.Errorf("%s: got %q, want %q", name, reason, c.reason)
		}
	}
	tampered := *good
	raw, _ := base64.StdEncoding.DecodeString(tampered.Sealed)
	raw[len(raw)-1] ^= 1
	tampered.Sealed = base64.StdEncoding.EncodeToString(raw)
	if _, reason := opener.Open(&tampered, connID, workID, now); reason != RefusedSealing {
		t.Errorf("a tampered login: %q", reason)
	}

	// After a renewal: the new key opens, and so does the one before for work sealed before.
	next := newKey(t)
	if err := opener.Use(next.Bytes(), key.Bytes()); err != nil {
		t.Fatal(err)
	}
	if _, reason := opener.Open(good, connID, workID, now); reason != "" {
		t.Errorf("the key before no longer opens: %s", reason)
	}
	if _, reason := opener.Open(seal(t, next.PublicKey(), info(agentID, connID, workID), document(expires, `"y"`), expires), connID, workID, now); reason != "" {
		t.Errorf("the new key does not open: %s", reason)
	}
	none, _ := NewOpener(agentID, orgID)
	if _, reason := none.Open(good, connID, workID, now); reason != RefusedNoKey {
		t.Errorf("no key: %q", reason)
	}
}

func TestUnquoteRefusesMalformed(t *testing.T) {
	for _, bad := range []string{`x`, `"`, `"\"`, `"\q"`, `"\u12"`, `"\u12zz"`} {
		if _, ok := unquote([]byte(bad)); ok {
			t.Errorf("%s unquoted", bad)
		}
	}
}

func TestTargets(t *testing.T) {
	targets, err := ParseTargets([]string{"db.corp.example", "*.plant.example", "10.20.0.0/16", "192.0.2.7", "2001:db8::/32"})
	if err != nil {
		t.Fatal(err)
	}
	resolve := func(_ context.Context, host string) ([]netip.Addr, error) {
		switch host {
		case "inside.example":
			return []netip.Addr{netip.MustParseAddr("10.20.1.2"), netip.MustParseAddr("2001:db8::5")}, nil
		case "straddles.example":
			return []netip.Addr{netip.MustParseAddr("10.20.1.2"), netip.MustParseAddr("10.99.0.1")}, nil
		}
		return nil, errors.New("no such host")
	}
	cases := []struct {
		host    string
		allowed bool
		addrs   []string
	}{
		{"db.corp.example", true, nil},
		{"DB.Corp.Example.", true, nil},
		{"line3.plant.example", true, nil},
		{"plant.example", false, nil},
		{"evil.example", false, nil},
		{"10.20.9.9", true, []string{"10.20.9.9"}},
		{"10.21.0.1", false, nil},
		{"192.0.2.7", true, []string{"192.0.2.7"}},
		{"192.0.2.8", false, nil},
		{"inside.example", true, []string{"10.20.1.2", "2001:db8::5"}},
		{"straddles.example", false, nil},
		{"unknown.example", false, nil},
		{"bad host!", false, nil},
	}
	for _, c := range cases {
		addrs, allowed := targets.Allow(context.Background(), c.host, resolve)
		if allowed != c.allowed || (c.allowed && fmt.Sprint(addrs) != fmt.Sprint(c.addrs)) {
			t.Errorf("%s: got %v %v, want %v %v", c.host, allowed, addrs, c.allowed, c.addrs)
		}
	}
	empty, _ := ParseTargets(nil)
	if _, allowed := empty.Allow(context.Background(), "10.20.9.9", resolve); allowed || !empty.Empty() {
		t.Error("with no targets, nothing is allowed")
	}
	for _, bad := range []string{"*.", "10.0.0.0/33", "not a host", "*.bad host"} {
		if _, err := ParseTargets([]string{bad}); err == nil {
			t.Errorf("%q parsed", bad)
		}
	}
}

func TestOpenKey(t *testing.T) {
	sealing := newKey(t)
	opener, err := NewOpener(agentID, orgID, sealing.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	rsaKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	pkcs8, _ := x509.MarshalPKCS8PrivateKey(rsaKey)
	now := time.Now()
	expires := now.Add(2 * time.Minute)
	doc := func(at time.Time) string {
		return fmt.Sprintf(`{"expiresAt":%q,"privateKey":%q}`, at.Format(time.RFC3339Nano), base64.StdEncoding.EncodeToString(pkcs8))
	}
	keyInfo := func(work string) string {
		return fmt.Sprintf("%s\x00{\"agentId\":%q,\"connectionId\":%q,\"organisationId\":%q,\"workId\":%q}", KeyInfo, agentID, connID, orgID, work)
	}
	key, reason := opener.OpenKey(seal(t, sealing.PublicKey(), keyInfo(workID), doc(expires), expires), connID, workID, now)
	if reason != "" || !key.Equal(rsaKey) {
		t.Fatalf("a good key refused: %q", reason)
	}
	// Sealed as a login, for the same work: a login's purpose never opens as a key, nor a key's as a login.
	if _, reason := opener.OpenKey(seal(t, sealing.PublicKey(), info(agentID, connID, workID), doc(expires), expires), connID, workID, now); reason != RefusedSealing {
		t.Errorf("a login's purpose opened as a key: %q", reason)
	}
	if _, reason := opener.Open(seal(t, sealing.PublicKey(), keyInfo(workID), document(expires, `"x"`), expires), connID, workID, now); reason != RefusedSealing {
		t.Errorf("a key's purpose opened as a login: %q", reason)
	}
	// Other work, and expiry inside the document.
	if _, reason := opener.OpenKey(seal(t, sealing.PublicKey(), keyInfo("0190f4a8-0000-7000-8000-0000000000ff"), doc(expires), expires), connID, workID, now); reason != RefusedSealing {
		t.Errorf("a key for other work opened: %q", reason)
	}
	if _, reason := opener.OpenKey(seal(t, sealing.PublicKey(), keyInfo(workID), doc(now.Add(-time.Second)), expires), connID, workID, now); reason != RefusedExpired {
		t.Errorf("an expired key opened: %q", reason)
	}
}
