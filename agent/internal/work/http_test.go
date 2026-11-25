package work

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
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"silohq.io/agent/internal/actuation"
	"silohq.io/agent/internal/grant"
	"silohq.io/agent/internal/login"
	"silohq.io/agent/internal/protocol"
)

const (
	httpOrg        = "01a1e000-0000-7000-8000-00000000000a"
	httpConnection = "01a1e000-0000-7000-8000-00000000000b"
)

type httpSigner struct {
	key   ed25519.PrivateKey
	pem   string
	keyID string
	n     int
}

func newHTTPSigner(t *testing.T) *httpSigner {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(public)
	sum := sha256.Sum256(der)
	return &httpSigner{key: private, pem: string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})), keyID: base64.RawURLEncoding.EncodeToString(sum[:])}
}

// sign makes a grant as the cell's actions does for a webhook delivery: one statement, the statements' hash.
func (s *httpSigner) sign(statements []byte) *grant.Signed {
	s.n++
	sum := sha256.Sum256(statements)
	now := time.Now().UTC()
	g := grant.Grant{Version: 1, GrantID: "01a1e000-0000-7000-8000-0000000001" + hex.EncodeToString([]byte{byte(s.n)}), OrganisationID: httpOrg,
		ActionID: "01a1e000-0000-7000-8000-00000000000c", ActionKind: "mutation", ConnectionID: httpConnection, Object: "webhook", Statements: 1,
		PayloadSHA256: hex.EncodeToString(sum[:]), IssuedAt: now, ExpiresAt: now.Add(5 * time.Minute)}
	text, _ := json.Marshal(g)
	signature := ed25519.Sign(s.key, append([]byte(grant.Prefix+"\x00"), text...))
	return &grant.Signed{Grant: string(text), KeyID: s.keyID, Signature: base64.RawURLEncoding.EncodeToString(signature)}
}

func send(t *testing.T, h *HTTP, w map[string]any) map[string]any {
	t.Helper()
	payload, _ := json.Marshal(w)
	var got map[string]any
	if err := h.Send(context.Background(), payload, func(frame any) error {
		raw, _ := json.Marshal(frame)
		return json.Unmarshal(raw, &got)
	}); err != nil {
		t.Fatal(err)
	}
	return got
}

func TestAWebhookToAPrivateTargetRunsOnItsGrantAndReachesOnlyAllowedHosts(t *testing.T) {
	var mu sync.Mutex
	var received []*http.Request
	var bodies []string
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		mu.Lock()
		received = append(received, r)
		bodies = append(bodies, string(raw))
		mu.Unlock()
		switch r.URL.Path {
		case "/status":
			_, _ = w.Write([]byte(`{"state":"applied","detail":"not passed on"}`))
		case "/moved":
			http.Redirect(w, r, "https://elsewhere.example/", http.StatusFound)
		default:
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte("a body never returned"))
		}
	}))
	defer server.Close()
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	signer := newHTTPSigner(t)
	verifier, err := grant.NewVerifier(signer.pem, httpOrg)
	if err != nil {
		t.Fatal(err)
	}
	targets, _ := login.ParseTargets([]string{"127.0.0.1"})
	h := NewHTTP(verifier, targets)
	h.Roots = roots
	base := server.URL
	request := func(method, path, body string) []byte {
		raw, _ := json.Marshal([]HTTPRequest{{Method: method, URL: base + path, Headers: map[string]string{"content-type": "application/json", "silo-signature": "v1=x"}, Body: body}})
		return raw
	}

	post := request("POST", "/hook", `{"mutationId":"m1"}`)
	got := send(t, h, map[string]any{"connectionId": httpConnection, "grant": signer.sign(post), "statements": json.RawMessage(post)})
	if got["type"] != "http_result" || got["status"] != float64(202) || got["state"] != nil {
		t.Fatalf("a granted post answers with its status alone: %v", got)
	}
	if len(received) != 1 || bodies[0] != `{"mutationId":"m1"}` || received[0].Header.Get("silo-signature") != "v1=x" {
		t.Fatalf("the target received the request as sent")
	}

	// The same grant again: spent.
	again := send(t, h, map[string]any{"connectionId": httpConnection, "grant": signer.sign(post), "statements": json.RawMessage(post)})
	if again["status"] != float64(202) {
		t.Fatalf("a new grant runs: %v", again)
	}
	spent := signer.sign(post)
	send(t, h, map[string]any{"connectionId": httpConnection, "grant": spent, "statements": json.RawMessage(post)})
	if replay := send(t, h, map[string]any{"connectionId": httpConnection, "grant": spent, "statements": json.RawMessage(post)}); replay["reason"] != "replayed" {
		t.Fatalf("a grant runs once: %v", replay)
	}
	// Unsigned, or for a different request: refused, and nothing is sent.
	before := len(received)
	if out := send(t, h, map[string]any{"connectionId": httpConnection, "statements": json.RawMessage(post)}); out["category"] != protocol.GrantRefused || out["reason"] != "unsigned" {
		t.Fatalf("unsigned: %v", out)
	}
	other := request("POST", "/hook", `{"mutationId":"m2"}`)
	if out := send(t, h, map[string]any{"connectionId": httpConnection, "grant": signer.sign(post), "statements": json.RawMessage(other)}); out["reason"] != "payload" {
		t.Fatalf("another request's grant: %v", out)
	}
	if len(received) != before {
		t.Fatalf("a refused request is never sent")
	}

	// A status endpoint: read with no grant; its state, never its body.
	status := send(t, h, map[string]any{"connectionId": httpConnection, "statements": json.RawMessage(request("GET", "/status", ""))})
	if status["status"] != float64(200) || status["state"] != "applied" || len(status) != 3 {
		t.Fatalf("the status endpoint's state: %v", status)
	}
	// A redirect is not followed.
	moved := send(t, h, map[string]any{"connectionId": httpConnection, "statements": json.RawMessage(request("GET", "/moved", ""))})
	if moved["status"] != float64(302) {
		t.Fatalf("a redirect is answered, not followed: %v", moved)
	}
	// A host the host's owner does not allow: refused before anything leaves.
	elsewhere, _ := json.Marshal([]HTTPRequest{{Method: "GET", URL: strings.Replace(base, "127.0.0.1", "localhost", 1) + "/status"}})
	if out := send(t, h, map[string]any{"connectionId": httpConnection, "statements": json.RawMessage(elsewhere)}); out["category"] != protocol.TargetRefused {
		t.Fatalf("a target not allowed: %v", out)
	}
	// Plain HTTP, or a header a webhook does not carry: refused.
	plain, _ := json.Marshal([]HTTPRequest{{Method: "GET", URL: strings.Replace(base, "https://", "http://", 1) + "/status"}})
	if out := send(t, h, map[string]any{"connectionId": httpConnection, "statements": json.RawMessage(plain)}); out["category"] != protocol.Integrity {
		t.Fatalf("plain http: %v", out)
	}
	smuggled, _ := json.Marshal([]HTTPRequest{{Method: "GET", URL: base + "/status", Headers: map[string]string{"authorization": "Bearer x"}}})
	if out := send(t, h, map[string]any{"connectionId": httpConnection, "statements": json.RawMessage(smuggled)}); out["category"] != protocol.Integrity {
		t.Fatalf("an unexpected header: %v", out)
	}
}

// A physical target's POST (47.1, 47.4, 47.5): sent only while the agent's own signed list
// names its action as a webhook command, outside the entry's interval, within the rate.
func TestAPhysicalWebhookIsSentOnlyAsItsSignedAllowListLets(t *testing.T) {
	var mu sync.Mutex
	hits := 0
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		hits++
		mu.Unlock()
		if r.URL.Path == "/busy" {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	cp := newControlPlane(t)
	verifier, _ := grant.NewVerifier(cp.pem, testOrgID)
	targets, _ := login.ParseTargets([]string{"127.0.0.1"})
	h := NewHTTP(verifier, targets)
	h.Roots = roots
	h.Allowlists, _ = actuation.NewStore(cp.pem, testOrgID)
	if reason := h.Allowlists.Replace(testConnID, []protocol.SignedEntry{
		cp.commandEntry("0190f4a8-0000-7000-8000-0000000000f1", "webhook", "open_valve", "command", 3600, "null"),
		cp.commandEntry("0190f4a8-0000-7000-8000-0000000000f2", "webhook", "retry_valve", "command", 3600, "null"),
		cp.commandEntry("0190f4a8-0000-7000-8000-0000000000f3", "mqtt", "close_valve", "command", 0, "null"),
		cp.commandEntry("0190f4a8-0000-7000-8000-0000000000f4", "webhook", "drain", "command", 0, "null"),
	}); reason != "" {
		t.Fatal(reason)
	}
	post := func(path, action string, perMinute int) map[string]any {
		raw, _ := json.Marshal([]HTTPRequest{{Method: "POST", URL: server.URL + path, Headers: map[string]string{"content-type": "application/json"}, Body: `{}`,
			Physical: &httpPhysical{Action: action, MaxPerMinute: perMinute}}})
		return send(t, h, map[string]any{"connectionId": testConnID, "grant": cp.grantFor(string(raw), 1), "statements": json.RawMessage(raw)})
	}

	if got := post("/valve", "open_valve", 0); got["status"] != float64(202) {
		t.Fatalf("a listed action is sent: %v", got)
	}
	if got := post("/valve", "open_valve", 0); got["category"] != protocol.ActuationRefused || got["reason"] != "interval" {
		t.Fatalf("again inside its interval: refused: %v", got)
	}
	// An attempt the target did not accept does not count: the delivery's retry is sent.
	if got := post("/busy", "retry_valve", 0); got["status"] != float64(503) {
		t.Fatalf("not accepted: %v", got)
	}
	if got := post("/valve", "retry_valve", 0); got["status"] != float64(202) {
		t.Fatalf("the retry is sent: %v", got)
	}
	if got := post("/valve", "close_valve", 0); got["category"] != protocol.ActuationRefused || got["reason"] != "not_listed" {
		t.Fatalf("listed for another transport only: %v", got)
	}
	if got := post("/valve", "vent", 0); got["reason"] != "not_listed" {
		t.Fatalf("an action not listed: %v", got)
	}
	// Two accepted in the last minute on this connection: a limit of two refuses a third.
	if got := post("/valve", "drain", 2); got["category"] != protocol.ActuationRefused || got["reason"] != "rate" {
		t.Fatalf("beyond the connection's writes a minute: %v", got)
	}
	if hits != 3 {
		t.Fatalf("refused sends never reach the target: %d", hits)
	}
	// A status read is never physical.
	raw, _ := json.Marshal([]HTTPRequest{{Method: "GET", URL: server.URL + "/status", Physical: &httpPhysical{Action: "drain"}}})
	if out := send(t, h, map[string]any{"connectionId": testConnID, "statements": json.RawMessage(raw)}); out["category"] != protocol.Integrity {
		t.Fatalf("a GET marked physical: %v", out)
	}
}
