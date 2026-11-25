package work

import (
	"context"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hpke"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"silohq.io/agent/internal/actuation"
	"silohq.io/agent/internal/grant"
	"sort"
	"strings"
	"testing"
	"time"

	"silohq.io/agent/internal/login"
	"silohq.io/agent/internal/opcuatest"
	"silohq.io/agent/internal/protocol"
)

func freeTCPPort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port
}

func opcuaRead(t *testing.T, o *OPCUA, read protocol.OPCUARead) []any {
	t.Helper()
	payload, _ := json.Marshal(read)
	var frames []any
	ctx := protocol.WithWorkID(context.Background(), "0190f4a8-0000-7000-8000-000000000043")
	if err := o.Read(ctx, payload, func(frame any) error { frames = append(frames, frame); return nil }); err != nil {
		t.Fatal(err)
	}
	return frames
}

func TestOPCUARead(t *testing.T) {
	port := freeTCPPort(t)
	plant, err := opcuatest.Start(context.Background(), port)
	if err != nil {
		t.Fatal(err)
	}
	defer plant.Close()
	allowed, _ := login.ParseTargets([]string{"127.0.0.0/8"})
	o := NewOPCUA(nil, allowed)
	endpoint := fmt.Sprintf("opc.tcp://127.0.0.1:%d", port)
	root := "nsu=" + opcuatest.NamespaceURI + ";s=Pumps"

	frames := opcuaRead(t, o, protocol.OPCUARead{
		ConnectionID: "0190f4a8-0000-7000-8000-000000000001", EndpointURL: endpoint, SecurityPolicy: "None", Root: root,
		Paths: []string{"$browseName", "$nodeId", "Temperature", "Mode", "Motor/Speed", "Missing/Node", "Motor/Speed/$nodeId"}, MaxInstances: 10,
	})
	if len(frames) != 2 {
		t.Fatalf("want rows then done, got %#v", frames)
	}
	rows := frames[0].(protocol.Rows).Rows
	sort.Slice(rows, func(i, j int) bool { return rows[i]["$browseName"].(string) < rows[j]["$browseName"].(string) })
	got := fmt.Sprint(rows)
	want := fmt.Sprint([]map[string]any{
		{"$browseName": "Pump1", "$nodeId": "nsu=" + opcuatest.NamespaceURI + ";s=Pump1", "Temperature": 61.5, "Mode": "auto", "Motor/Speed": int32(1450), "Missing/Node": nil,
			"Motor/Speed/$nodeId": "nsu=" + opcuatest.NamespaceURI + ";s=Pump1.Motor.Speed"},
		{"$browseName": "Pump2", "$nodeId": "nsu=" + opcuatest.NamespaceURI + ";s=Pump2", "Temperature": 71.5, "Mode": "manual", "Motor/Speed": int32(0), "Missing/Node": nil,
			"Motor/Speed/$nodeId": "nsu=" + opcuatest.NamespaceURI + ";s=Pump2.Motor.Speed"},
	})
	if got != want {
		t.Errorf("rows:\n got %s\nwant %s", got, want)
	}
	if done := frames[1].(protocol.Done); done.RowCount != 2 || done.Truncated {
		t.Errorf("done: %#v", done)
	}

	// More instances than maxInstances: reported truncated.
	cut := opcuaRead(t, o, protocol.OPCUARead{ConnectionID: "0190f4a8-0000-7000-8000-000000000001", EndpointURL: endpoint, SecurityPolicy: "None", Root: root,
		Paths: []string{"$browseName"}, MaxInstances: 1})
	if done := cut[len(cut)-1].(protocol.Done); !done.Truncated || done.RowCount != 1 {
		t.Errorf("want truncated after one, got %#v", done)
	}
	// A namespace the server does not have: refused, never guessed.
	missing := opcuaRead(t, o, protocol.OPCUARead{ConnectionID: "0190f4a8-0000-7000-8000-000000000001", EndpointURL: endpoint, SecurityPolicy: "None",
		Root: "nsu=urn:elsewhere;s=Pumps", Paths: []string{"$browseName"}})
	if missing[0].(protocol.Error).Category != protocol.SourceRefused {
		t.Errorf("an unknown namespace: %#v", missing)
	}
}

func TestOPCUAReadRefusals(t *testing.T) {
	allowed, _ := login.ParseTargets([]string{"127.0.0.0/8"})
	elsewhere, _ := login.ParseTargets([]string{"10.0.0.0/8"})
	base := protocol.OPCUARead{ConnectionID: "0190f4a8-0000-7000-8000-000000000001", EndpointURL: "opc.tcp://127.0.0.1:4840", SecurityPolicy: "None",
		Root: "nsu=urn:x;s=Pumps", Paths: []string{"Temperature"}}
	if frames := opcuaRead(t, NewOPCUA(nil, elsewhere), base); frames[0].(protocol.Error).Category != protocol.TargetRefused {
		t.Errorf("a server the host's owner does not allow: %#v", frames)
	}
	for name, change := range map[string]func(r *protocol.OPCUARead){
		"a signed policy without its certificate": func(r *protocol.OPCUARead) { r.SecurityPolicy = "Basic256Sha256 SignAndEncrypt" },
		"a deprecated policy":                     func(r *protocol.OPCUARead) { r.SecurityPolicy = "Basic256 Sign" },
		"a namespace index":                       func(r *protocol.OPCUARead) { r.Root = "ns=2;s=Pumps" },
		"an http endpoint":                        func(r *protocol.OPCUARead) { r.EndpointURL = "http://127.0.0.1:4840" },
		"an empty path segment":                   func(r *protocol.OPCUARead) { r.Paths = []string{"Motor//Speed"} },
	} {
		read := base
		change(&read)
		if frames := opcuaRead(t, NewOPCUA(nil, allowed), read); frames[0].(protocol.Error).Category != protocol.Integrity {
			t.Errorf("%s: want integrity, got %#v", name, frames)
		}
	}
}

const (
	testAgentID = "0190f4a8-0000-7000-8000-0000000000a1"
	testOrgID   = "0190f4a8-0000-7000-8000-0000000000a2"
	testConnID  = "0190f4a8-0000-7000-8000-000000000001"
	testWorkID  = "0190f4a8-0000-7000-8000-000000000043"
)

// application makes what the cell's credential service makes for an endpoint: an RSA key and a
// self-signed application instance certificate with the application URI.
func application(t *testing.T) ([]byte, *rsa.PrivateKey) {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	uri, _ := url.Parse("urn:silohq.io:agent:opcua:0190f4a8-0000-7000-8000-0000000000e1")
	template := &x509.Certificate{
		SerialNumber: big.NewInt(7), Subject: pkix.Name{CommonName: "Silo Agent"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageContentCommitment | x509.KeyUsageKeyEncipherment |
			x509.KeyUsageDataEncipherment | x509.KeyUsageCertSign,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth}, BasicConstraintsValid: true, URIs: []*url.URL{uri},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return der, key
}

// sealKey seals the key as the cell does (sealOpcUaApplicationKey) for this agent, connection and work.
func sealKey(t *testing.T, to *ecdh.PublicKey, key *rsa.PrivateKey, work string) *protocol.SealedLogin {
	t.Helper()
	pkcs8, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	expires := time.Now().Add(2 * time.Minute)
	document := fmt.Sprintf(`{"expiresAt":%q,"privateKey":%q}`, expires.Format(time.RFC3339Nano), base64.StdEncoding.EncodeToString(pkcs8))
	info := fmt.Sprintf("%s\x00{\"agentId\":%q,\"connectionId\":%q,\"organisationId\":%q,\"workId\":%q}", login.KeyInfo, testAgentID, testConnID, testOrgID, work)
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

func opcuaProbe(t *testing.T, o *OPCUA, server protocol.OPCUAServer) []any {
	t.Helper()
	payload, _ := json.Marshal(protocol.OPCUAProbe{OPCUAServer: server})
	var frames []any
	ctx := protocol.WithWorkID(context.Background(), testWorkID)
	if err := o.Probe(ctx, payload, func(frame any) error { frames = append(frames, frame); return nil }); err != nil {
		t.Fatal(err)
	}
	return frames
}

func TestOPCUASigned(t *testing.T) {
	trust := t.TempDir()
	port := freeTCPPort(t)
	plant, err := opcuatest.StartSecure(context.Background(), port, trust)
	if err != nil {
		t.Fatal(err)
	}
	defer plant.Close()
	sealing, _ := ecdh.X25519().GenerateKey(rand.Reader)
	opener, err := login.NewOpener(testAgentID, testOrgID, sealing.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	allowed, _ := login.ParseTargets([]string{"127.0.0.0/8"})
	o := NewOPCUA(opener, allowed)
	certificate, key := application(t)
	pin := sha256.Sum256(plant.Certificate)
	server := func(policy string) protocol.OPCUAServer {
		return protocol.OPCUAServer{
			ConnectionID: testConnID, EndpointURL: fmt.Sprintf("opc.tcp://127.0.0.1:%d", port), SecurityPolicy: policy,
			ServerThumbprint: hex.EncodeToString(pin[:]), Certificate: base64.StdEncoding.EncodeToString(certificate),
			ApplicationKey: sealKey(t, sealing.PublicKey(), key, testWorkID),
		}
	}
	refusal := func(frames []any) string {
		if e, ok := frames[0].(protocol.Error); ok {
			return e.Category + "/" + e.Reason
		}
		return fmt.Sprintf("%#v", frames)
	}

	// Not yet trusted on the server: refused as untrusted.
	if got := refusal(opcuaProbe(t, o, server("Basic256Sha256 SignAndEncrypt"))); got != "source_refused/untrusted" {
		t.Fatalf("an untrusted application: %s", got)
	}
	// The customer's step: the certificate into the server's trust list.
	if err := os.WriteFile(filepath.Join(trust, "silo-agent.pem"), pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certificate}), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, policy := range []string{"Basic256Sha256 SignAndEncrypt", "Basic256Sha256 Sign"} {
		frames := opcuaProbe(t, o, server(policy))
		rows, ok := frames[0].(protocol.Rows)
		if !ok {
			t.Fatalf("%s: a trusted probe: %s", policy, refusal(frames))
		}
		row := rows.Rows[0]
		if row["serverSha256"] != hex.EncodeToString(pin[:]) || !contains(row["namespaceUris"].([]string), opcuatest.NamespaceURI) {
			t.Errorf("%s: probe row %#v", policy, row)
		}
	}
	read := protocol.OPCUARead{OPCUAServer: server("Basic256Sha256 SignAndEncrypt"), Root: "nsu=" + opcuatest.NamespaceURI + ";s=Pumps",
		Paths: []string{"$browseName", "Motor/Speed"}, MaxInstances: 10}
	frames := opcuaRead(t, o, read)
	rows, ok := frames[0].(protocol.Rows)
	if !ok || len(rows.Rows) != 2 {
		t.Fatalf("a signed and encrypted read: %s", refusal(frames))
	}

	// Another certificate than the pinned one: refused before the channel opens.
	wrong := server("Basic256Sha256 SignAndEncrypt")
	wrong.ServerThumbprint = "00" + wrong.ServerThumbprint[2:]
	if got := refusal(opcuaProbe(t, o, wrong)); got != "source_refused/server_certificate" {
		t.Errorf("a server certificate not pinned: %s", got)
	}
	// A policy the server does not offer.
	if got := refusal(opcuaProbe(t, o, server("Aes256_Sha256_RsaPss SignAndEncrypt"))); got != "source_refused/policy" {
		t.Errorf("a policy not offered: %s", got)
	}
	// A key that is not the certificate's: never sent.
	_, other := application(t)
	mismatched := server("Basic256Sha256 Sign")
	mismatched.ApplicationKey = sealKey(t, sealing.PublicKey(), other, testWorkID)
	if got := refusal(opcuaProbe(t, o, mismatched)); got != "integrity/" {
		t.Errorf("a key not the certificate's: %s", got)
	}
	// A key sealed for other work does not open for this.
	elsewhere := server("Basic256Sha256 Sign")
	elsewhere.ApplicationKey = sealKey(t, sealing.PublicKey(), key, "0190f4a8-0000-7000-8000-000000000099")
	if got := refusal(opcuaProbe(t, o, elsewhere)); got != "login_refused/sealing" {
		t.Errorf("a key sealed for other work: %s", got)
	}
}

func contains(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}

func TestOPCUAMonitor(t *testing.T) {
	port := freeTCPPort(t)
	plant, err := opcuatest.Start(context.Background(), port)
	if err != nil {
		t.Fatal(err)
	}
	defer plant.Close()
	allowed, _ := login.ParseTargets([]string{"127.0.0.0/8"})
	o := NewOPCUA(nil, allowed)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	samples := make(chan map[string]any, 100)
	begun := make(chan struct{})
	ended := make(chan *protocol.Error, 1)
	go func() {
		ended <- o.Monitor(ctx, testConnID, "0190f4a8-0000-7000-8000-0000000000c1", &protocol.OPCUACapture{
			OPCUAServer: protocol.OPCUAServer{EndpointURL: fmt.Sprintf("opc.tcp://127.0.0.1:%d", port), SecurityPolicy: "None"},
			Objects: []protocol.OPCUAMonitored{{
				Object: "pumps", Root: "nsu=" + opcuatest.NamespaceURI + ";s=Pumps", Paths: []string{"$browseName", "Motor/Speed", "Missing"},
				SamplingMs: 50, QueueSize: 10, Deadband: &protocol.OPCUADeadband{Type: "absolute", Value: 1},
			}},
		}, func() error { close(begun); return nil }, func(batch []map[string]any) error {
			for _, sample := range batch {
				samples <- sample
			}
			return nil
		})
	}()
	select {
	case <-begun:
	case refusal := <-ended:
		t.Fatalf("the capture did not start: %#v", refusal)
	case <-time.After(15 * time.Second):
		t.Fatal("the capture did not start")
	}
	next := func() map[string]any {
		t.Helper()
		select {
		case sample := <-samples:
			return sample
		case <-time.After(10 * time.Second):
			t.Fatal("no sample arrived")
			return nil
		}
	}
	// The first notification of each item is its value now: the backfill.
	initial := map[string]any{}
	for range 2 {
		sample := next()
		if sample["object"] != "pumps" || sample["path"] != "Motor/Speed" || sample["status"] != "good" {
			t.Fatalf("an initial sample: %#v", sample)
		}
		initial[sample["browseName"].(string)] = sample["value"]
	}
	if fmt.Sprint(initial) != fmt.Sprint(map[string]any{"Pump1": int32(1450), "Pump2": int32(0)}) {
		t.Fatalf("initial values: %v", initial)
	}
	// A change on the server is published.
	plant.SetSpeed("Pump1", 1500)
	sample := next()
	if sample["browseName"] != "Pump1" || sample["value"] != int32(1500) || sample["nodeId"] != "nsu="+opcuatest.NamespaceURI+";s=Pump1" || sample["serverAt"] == nil {
		t.Fatalf("the changed sample: %#v", sample)
	}
	cancel()
	select {
	case refusal := <-ended:
		if refusal != nil {
			t.Fatalf("ended with %#v", refusal)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the capture did not end")
	}
}

func TestOPCUABrowse(t *testing.T) {
	port := freeTCPPort(t)
	plant, err := opcuatest.Start(context.Background(), port)
	if err != nil {
		t.Fatal(err)
	}
	defer plant.Close()
	allowed, _ := login.ParseTargets([]string{"127.0.0.0/8"})
	ctx := protocol.WithWorkID(context.Background(), testWorkID)
	found, refusal := NewOPCUA(nil, allowed).Browse(ctx, protocol.OPCUAServer{
		ConnectionID: testConnID, EndpointURL: fmt.Sprintf("opc.tcp://127.0.0.1:%d", port), SecurityPolicy: "None",
	})
	if refusal != nil {
		t.Fatalf("browse refused: %#v", refusal)
	}
	if !contains(found.NamespaceURIs, opcuatest.NamespaceURI) || found.Truncated {
		t.Errorf("namespaces %v, truncated %v", found.NamespaceURIs, found.Truncated)
	}
	got, _ := json.Marshal(found.Types)
	want := `[{"name":"Pumps","typeDefinition":"","root":"nsu=urn:silo:test:plant;s=Pumps","instances":2,` +
		`"variables":[{"path":"Mode","dataType":"String","writable":false},{"path":"Motor/Speed","dataType":"Int32","writable":true},` +
		`{"path":"Temperature","dataType":"Double","writable":false}],"references":[]}]`
	if string(got) != want {
		t.Errorf("types:\n got %s\nwant %s", got, want)
	}
	// Structure only: no value is in what browsing found.
	all, _ := json.Marshal(found)
	for _, value := range []string{"61.5", "1450", "auto", "manual"} {
		if strings.Contains(string(all), value) {
			t.Errorf("a value in the structure: %s", value)
		}
	}
}

// controlPlane signs what the cell's actions signs: execution grants and allow-list entries.
type controlPlane struct {
	private ed25519.PrivateKey
	pem     string
	id      string
}

func newControlPlane(t *testing.T) controlPlane {
	t.Helper()
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(public)
	keyPEM := string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der}))
	sum := sha256.Sum256(der)
	return controlPlane{private: private, pem: keyPEM, id: base64.RawURLEncoding.EncodeToString(sum[:])}
}

func (c controlPlane) sign(prefix, text string) string {
	return base64.RawURLEncoding.EncodeToString(ed25519.Sign(c.private, append(append([]byte(prefix), 0), text...)))
}

func (c controlPlane) entry(id, address, minValue, maxValue, maxStep string, interval int) protocol.SignedEntry {
	return c.entryWith(id, address, minValue, maxValue, maxStep, interval, "null")
}

// entryWith names a simulator node (a JSON string), or null.
func (c controlPlane) entryWith(id, address, minValue, maxValue, maxStep string, interval int, simulator string) protocol.SignedEntry {
	text := fmt.Sprintf(`{"added_by":"0190f4a8-0000-7000-8000-0000000000b1","approved_at":"2026-11-18T14:00:00.000Z",`+
		`"approved_by":"0190f4a8-0000-7000-8000-0000000000b2","connection_id":%q,"data_type":"Int32","id":%q,"inverse_command":null,`+
		`"kind":"setpoint","max_step":%q,"max_value":%q,"min_interval_seconds":%d,"min_value":%q,"node_address":%q,`+
		`"object_id":"0190f4a8-0000-7000-8000-0000000000c1","organisation_id":%q,"purpose":"actuation_allowlist_entry",`+
		`"simulator_address":%s,"transport":"opcua","v":1}`, testConnID, id, maxStep, maxValue, interval, minValue, address, testOrgID, simulator)
	return protocol.SignedEntry{Entry: text, KeyID: c.id, Signature: c.sign(actuation.Prefix, text)}
}

// grantFor is the grant actions signs for exactly these statements.
func (c controlPlane) grantFor(statements string, count int) map[string]any {
	sum := sha256.Sum256([]byte(statements))
	now := time.Now().UTC()
	text := fmt.Sprintf(`{"version":1,"grantId":%q,"organisationId":%q,"actionId":"0190f4a8-0000-7000-8000-0000000000d1","actionKind":"mutation",`+
		`"connectionId":%q,"object":"pumps","statements":%d,"payloadSha256":%q,"issuedAt":%q,"expiresAt":%q}`,
		fmt.Sprintf("0190f4a8-0000-7000-8000-%012d", now.UnixNano()%1e12), testOrgID, testConnID, count, hex.EncodeToString(sum[:]),
		now.Format(time.RFC3339Nano), now.Add(time.Minute).Format(time.RFC3339Nano))
	return map[string]any{"grant": text, "keyId": c.id, "signature": c.sign(grant.Prefix, text)}
}

func TestOPCUAWrite(t *testing.T) {
	port := freeTCPPort(t)
	plant, err := opcuatest.Start(context.Background(), port)
	if err != nil {
		t.Fatal(err)
	}
	defer plant.Close()
	cp := newControlPlane(t)
	allowed, _ := login.ParseTargets([]string{"127.0.0.0/8"})
	o := NewOPCUA(nil, allowed)
	o.Grants, _ = grant.NewVerifier(cp.pem, testOrgID)
	o.Allowlists, _ = actuation.NewStore(cp.pem, testOrgID)
	pump := func(n int) string { return fmt.Sprintf("nsu=%s;s=Pump%d.Motor.Speed", opcuatest.NamespaceURI, n) }
	if reason := o.Allowlists.Replace(testConnID, []protocol.SignedEntry{
		cp.entry("0190f4a8-0000-7000-8000-0000000000e1", pump(1), "0", "1800", "200", 30),
	}); reason != "" {
		t.Fatal(reason)
	}
	write := func(statements string, signed bool) []any {
		t.Helper()
		var parsed []any
		_ = json.Unmarshal([]byte(statements), &parsed)
		work := map[string]any{
			"connectionId": testConnID, "endpointUrl": fmt.Sprintf("opc.tcp://127.0.0.1:%d", port), "securityPolicy": "None",
			"root": "nsu=" + opcuatest.NamespaceURI + ";s=Pumps", "statements": json.RawMessage(statements),
		}
		if signed {
			work["grant"] = cp.grantFor(statements, len(parsed))
		}
		payload, _ := json.Marshal(work)
		var frames []any
		ctx := protocol.WithWorkID(context.Background(), testWorkID)
		if err := o.Write(ctx, payload, func(frame any) error { frames = append(frames, frame); return nil }); err != nil {
			t.Fatal(err)
		}
		return frames
	}
	outcome := func(frames []any) string {
		if e, ok := frames[0].(protocol.Error); ok {
			return e.Category + "/" + e.Reason
		}
		row := frames[0].(protocol.Rows).Rows[0]
		return fmt.Sprint(row["outcome"], "/", row["reason"])
	}
	setSpeed := func(instance string, rpm int) string {
		return fmt.Sprintf(`[{"key":"k1","instance":%q,"writes":[{"path":"Motor/Speed","value":%d}],"maxPerMinute":10}]`, instance, rpm)
	}

	if got := outcome(write(setSpeed("Pump1", 1500), false)); got != "grant_refused/unsigned" {
		t.Errorf("unsigned: %s", got)
	}
	// Listed, in range, a step of 50 from 1450: written.
	frames := write(setSpeed("Pump1", 1500), true)
	if got := outcome(frames); got != "applied/<nil>" || plant.Speed("Pump1") != 1500 {
		t.Fatalf("a listed setpoint: %s, speed %d", got, plant.Speed("Pump1"))
	}
	if node := frames[0].(protocol.Rows).Rows[0]["nodes"].([]map[string]any)[0]; node["nodeAddress"] != pump(1) || node["entryId"] != "0190f4a8-0000-7000-8000-0000000000e1" {
		t.Errorf("the node written: %#v", node)
	}
	// Each refused before anything is written.
	for name, c := range map[string]struct{ statements, want string }{
		"inside the interval": {setSpeed("Pump1", 1550), "refused/interval"},
		"not listed":          {setSpeed("Pump2", 100), "refused/not_listed"},
		"no such instance":    {setSpeed("Pump9", 100), "refused/instance"},
	} {
		if got := outcome(write(c.statements, true)); got != c.want {
			t.Errorf("%s: %s", name, got)
		}
	}
	if plant.Speed("Pump1") != 1500 || plant.Speed("Pump2") != 0 {
		t.Errorf("something was written: %d, %d", plant.Speed("Pump1"), plant.Speed("Pump2"))
	}
	// Range and step, on an entry with no interval.
	if reason := o.Allowlists.Replace(testConnID, []protocol.SignedEntry{
		cp.entry("0190f4a8-0000-7000-8000-0000000000e2", pump(2), "0", "5000", "100", 0),
	}); reason != "" {
		t.Fatal(reason)
	}
	if got := outcome(write(setSpeed("Pump2", 6000), true)); got != "refused/range" {
		t.Errorf("out of range: %s", got)
	}
	if got := outcome(write(setSpeed("Pump2", 500), true)); got != "refused/step" {
		t.Errorf("too large a step: %s", got)
	}
	// The control system's own word: within the entry, but the plant refuses above its maximum.
	if reason := o.Allowlists.Replace(testConnID, []protocol.SignedEntry{
		cp.entry("0190f4a8-0000-7000-8000-0000000000e3", pump(2), "0", "5000", "5000", 0),
	}); reason != "" {
		t.Fatal(reason)
	}
	if got := outcome(write(setSpeed("Pump2", 4000), true)); got != "rejected/<nil>" || plant.Speed("Pump2") != 0 {
		t.Errorf("rejected by the control system: %s, speed %d", got, plant.Speed("Pump2"))
	}
	// Clamped by the plant: applied (GoodClamped is good); the cell's read-back finds it diverged.
	if got := outcome(write(setSpeed("Pump2", 2500), true)); got != "applied/<nil>" || plant.Speed("Pump2") != opcuatest.ClampSpeed {
		t.Errorf("clamped: %s, speed %d", got, plant.Speed("Pump2"))
	}
	// A dry run (47.5): the simulator node the signed entry names is written and read back; production is not.
	dryRun := func(instance string, rpm int) string {
		return fmt.Sprintf(`[{"key":"k1","instance":%q,"writes":[{"path":"Motor/Speed","value":%d}],"maxPerMinute":10,"dryRun":true}]`, instance, rpm)
	}
	if reason := o.Allowlists.Replace(testConnID, []protocol.SignedEntry{
		cp.entry("0190f4a8-0000-7000-8000-0000000000e1", pump(1), "0", "1800", "200", 30),
	}); reason != "" {
		t.Fatal(reason)
	}
	if got := outcome(write(dryRun("Pump1", 1550), true)); got != "refused/no_simulator" {
		t.Errorf("a dry run with no simulator node: %s", got)
	}
	sim := fmt.Sprintf("nsu=%s;s=Sim.Pump1.Motor.Speed", opcuatest.NamespaceURI)
	if reason := o.Allowlists.Replace(testConnID, []protocol.SignedEntry{
		cp.entryWith("0190f4a8-0000-7000-8000-0000000000e4", pump(1), "0", "1800", "200", 30, fmt.Sprintf("%q", sim)),
	}); reason != "" {
		t.Fatal(reason)
	}
	// Inside production's interval, but a dry run does not count against it.
	frames = write(dryRun("Pump1", 1550), true)
	if got := outcome(frames); got != "applied/<nil>" || plant.Speed("Sim.Pump1") != 1550 || plant.Speed("Pump1") != 1500 {
		t.Fatalf("a dry run: %s, simulator %d, production %d", got, plant.Speed("Sim.Pump1"), plant.Speed("Pump1"))
	}
	if node := frames[0].(protocol.Rows).Rows[0]["nodes"].([]map[string]any)[0]; node["simulatorAddress"] != sim || node["observed"] != int32(1550) {
		t.Errorf("the simulator read back: %#v", node)
	}

	// A grant for other statements does not cover these.
	tampered := setSpeed("Pump2", 2400)
	work := map[string]any{
		"connectionId": testConnID, "endpointUrl": fmt.Sprintf("opc.tcp://127.0.0.1:%d", port), "securityPolicy": "None",
		"root": "nsu=" + opcuatest.NamespaceURI + ";s=Pumps", "statements": json.RawMessage(tampered), "grant": cp.grantFor(setSpeed("Pump2", 2300), 1),
	}
	payload, _ := json.Marshal(work)
	var got []any
	_ = o.Write(protocol.WithWorkID(context.Background(), testWorkID), payload, func(frame any) error { got = append(got, frame); return nil })
	if outcome(got) != "grant_refused/payload" {
		t.Errorf("another plan's grant: %s", outcome(got))
	}
}

// commandEntry is a command's signed entry: no range or step; a simulator node (JSON) or null.
func (c controlPlane) commandEntry(id, transport, address, kind string, interval int, simulator string) protocol.SignedEntry {
	text := fmt.Sprintf(`{"added_by":"0190f4a8-0000-7000-8000-0000000000b1","approved_at":"2026-11-18T14:00:00.000Z",`+
		`"approved_by":"0190f4a8-0000-7000-8000-0000000000b2","connection_id":%q,"data_type":"Boolean","id":%q,"inverse_command":null,`+
		`"kind":%q,"max_step":null,"max_value":null,"min_interval_seconds":%d,"min_value":null,"node_address":%q,`+
		`"object_id":"0190f4a8-0000-7000-8000-0000000000c1","organisation_id":%q,"purpose":"actuation_allowlist_entry",`+
		`"simulator_address":%s,"transport":%q,"v":1}`, testConnID, id, kind, interval, address, testOrgID, simulator, transport)
	return protocol.SignedEntry{Entry: text, KeyID: c.id, Signature: c.sign(actuation.Prefix, text)}
}

// methodEntry is a method's entry with input arguments (D245), as the cell signs it: keys sorted.
func (c controlPlane) methodEntry(id, address, arguments string, simulator string) protocol.SignedEntry {
	text := fmt.Sprintf(`{"added_by":"0190f4a8-0000-7000-8000-0000000000b1","approved_at":"2026-11-18T14:00:00.000Z",`+
		`"approved_by":"0190f4a8-0000-7000-8000-0000000000b2","arguments":%s,"connection_id":%q,"data_type":"Boolean","id":%q,"inverse_command":null,`+
		`"kind":"method","max_step":null,"max_value":null,"min_interval_seconds":0,"min_value":null,"node_address":%q,`+
		`"object_id":"0190f4a8-0000-7000-8000-0000000000c1","organisation_id":%q,"purpose":"actuation_allowlist_entry",`+
		`"simulator_address":%s,"transport":"opcua","v":1}`, arguments, testConnID, id, address, testOrgID, simulator)
	return protocol.SignedEntry{Entry: text, KeyID: c.id, Signature: c.sign(actuation.Prefix, text)}
}

func TestOPCUACall(t *testing.T) {
	port := freeTCPPort(t)
	plant, err := opcuatest.Start(context.Background(), port)
	if err != nil {
		t.Fatal(err)
	}
	defer plant.Close()
	cp := newControlPlane(t)
	allowed, _ := login.ParseTargets([]string{"127.0.0.0/8"})
	o := NewOPCUA(nil, allowed)
	o.Grants, _ = grant.NewVerifier(cp.pem, testOrgID)
	o.Allowlists, _ = actuation.NewStore(cp.pem, testOrgID)
	methodOf := func(pump, m string) string {
		return fmt.Sprintf("nsu=%s;s=%s.Motor.%s", opcuatest.NamespaceURI, pump, m)
	}
	if reason := o.Allowlists.Replace(testConnID, []protocol.SignedEntry{
		cp.commandEntry("0190f4a8-0000-7000-8000-0000000000f1", "opcua", methodOf("Pump2", "Start"), "method", 60, "null"),
		cp.commandEntry("0190f4a8-0000-7000-8000-0000000000f2", "opcua", methodOf("Pump2", "Jog"), "method", 0, "null"),
		cp.commandEntry("0190f4a8-0000-7000-8000-0000000000f3", "opcua", methodOf("Pump1", "Stop"), "method", 0, fmt.Sprintf("%q", methodOf("Sim.Pump1", "Stop"))),
		// Ramp(Rpm Int32, Mode String), D245: Pump2's listed as it is declared, with a simulator; Pump1's as if it took the speed alone.
		cp.methodEntry("0190f4a8-0000-7000-8000-0000000000f4", methodOf("Pump2", "Ramp"),
			`[{"data_type":"Int32","max_value":"1500","min_value":"0","name":"Rpm","values":null},{"data_type":"String","max_value":null,"min_value":null,"name":"Mode","values":["auto","manual"]}]`,
			fmt.Sprintf("%q", methodOf("Sim.Pump2", "Ramp"))),
		cp.methodEntry("0190f4a8-0000-7000-8000-0000000000f5", methodOf("Pump1", "Ramp"),
			`[{"data_type":"Int32","max_value":"1500","min_value":"0","name":"Rpm","values":null}]`, "null"),
	}); reason != "" {
		t.Fatal(reason)
	}
	call := func(statements string) string {
		t.Helper()
		var parsed []any
		_ = json.Unmarshal([]byte(statements), &parsed)
		payload, _ := json.Marshal(map[string]any{
			"connectionId": testConnID, "endpointUrl": fmt.Sprintf("opc.tcp://127.0.0.1:%d", port), "securityPolicy": "None",
			"root": "nsu=" + opcuatest.NamespaceURI + ";s=Pumps", "statements": json.RawMessage(statements), "grant": cp.grantFor(statements, len(parsed)),
		})
		var frames []any
		if err := o.Call(protocol.WithWorkID(context.Background(), testWorkID), payload, func(frame any) error { frames = append(frames, frame); return nil }); err != nil {
			t.Fatal(err)
		}
		if e, ok := frames[0].(protocol.Error); ok {
			return e.Category + "/" + e.Reason
		}
		row := frames[0].(protocol.Rows).Rows[0]
		return fmt.Sprint(row["outcome"], "/", row["reason"])
	}
	// A method's address resolves as a variable's does: what the cell checks against the allow-list (47.4).
	frames := opcuaRead(t, o, protocol.OPCUARead{
		ConnectionID: testConnID, EndpointURL: fmt.Sprintf("opc.tcp://127.0.0.1:%d", port), SecurityPolicy: "None",
		Root: "nsu=" + opcuatest.NamespaceURI + ";s=Pumps", Paths: []string{"$browseName", "Motor/Start/$nodeId", "Motor/Missing/$nodeId"}, MaxInstances: 10,
	})
	for _, row := range frames[0].(protocol.Rows).Rows {
		if want := methodOf(row["$browseName"].(string), "Start"); row["Motor/Start/$nodeId"] != want || row["Motor/Missing/$nodeId"] != nil {
			t.Errorf("method addresses: %v", row)
		}
	}
	command := func(pump, m string, dryRun bool) string {
		return fmt.Sprintf(`[{"key":"k1","instance":%q,"method":"Motor/%s","inputs":[],"maxPerMinute":10,"dryRun":%v}]`, pump, m, dryRun)
	}
	if got := call(command("Pump2", "Start", false)); got != "applied/<nil>" || !plant.Running("Pump2") {
		t.Fatalf("a listed method: %s, running %v", got, plant.Running("Pump2"))
	}
	if got := call(command("Pump2", "Start", false)); got != "refused/interval" {
		t.Errorf("inside the interval: %s", got)
	}
	if got := call(command("Pump2", "Stop", false)); got != "refused/not_listed" || !plant.Running("Pump2") {
		t.Errorf("not listed: %s", got)
	}
	if got := call(command("Pump2", "Jog", false)); got != "rejected/<nil>" {
		t.Errorf("the control system refuses: %s", got)
	}
	if got := call(`[{"key":"k1","instance":"Pump2","method":"Motor/Jog","inputs":[1],"maxPerMinute":10}]`); got != "refused/arguments" {
		t.Errorf("inputs to a method that takes none: %s", got)
	}
	// A method with input arguments (D245): each sent as the type the method declares, within its signed bounds.
	ramp := func(pump, inputs string, dryRun bool) string {
		return call(fmt.Sprintf(`[{"key":"k1","instance":%q,"method":"Motor/Ramp","inputs":%s,"maxPerMinute":10,"dryRun":%v}]`, pump, inputs, dryRun))
	}
	if got := ramp("Pump2", `[1200,"manual"]`, false); got != "applied/<nil>" || plant.Speed("Pump2") != 1200 || plant.Mode("Pump2") != "manual" {
		t.Fatalf("a ramp within bounds: %s, speed %d, mode %q", got, plant.Speed("Pump2"), plant.Mode("Pump2"))
	}
	for inputs, want := range map[string]string{
		`[1600,"manual"]`: "refused/range", `[-1,"auto"]`: "refused/range", `[100,"turbo"]`: "refused/range",
		`[12.5,"auto"]`: "refused/data_type", `["fast","auto"]`: "refused/data_type", `[100]`: "refused/arguments", `[100,"auto",true]`: "refused/arguments",
	} {
		if got := ramp("Pump2", inputs, false); got != want {
			t.Errorf("%s: %s, want %s", inputs, got, want)
		}
	}
	if plant.Speed("Pump2") != 1200 {
		t.Errorf("nothing refused reached the plant: %d", plant.Speed("Pump2"))
	}
	if got := ramp("Pump1", `[100]`, false); got != "refused/arguments" {
		t.Errorf("an entry that is not the method's declaration: %s", got)
	}
	// A dry run ramps the simulator's motor, which declares the same arguments; production's speed stays.
	if got := ramp("Pump2", `[300,"auto"]`, true); got != "applied/<nil>" || plant.Speed("Sim.Pump2") != 300 || plant.Speed("Pump2") != 1200 {
		t.Errorf("a dry run: %s, simulator %d, production %d", got, plant.Speed("Sim.Pump2"), plant.Speed("Pump2"))
	}
	// A dry run calls the simulator's method; production's motor keeps running.
	if got := call(command("Pump1", "Stop", true)); got != "applied/<nil>" || !plant.Running("Pump1") {
		t.Errorf("a dry run: %s, production running %v", got, plant.Running("Pump1"))
	}
	if got := call(command("Pump1", "Start", false)); got != "refused/not_listed" {
		t.Errorf("Pump1's start is not listed: %s", got)
	}
}
