// Package tunnel is the agent's side of agent.<cell> (spec 10.2): enrolment, then one
// long-lived HTTP/2 connection, outbound only, TCP 443, TLS 1.3 with the agent's client
// certificate, through an HTTP CONNECT proxy where configured. Heartbeats go up every ten
// seconds; work comes down and is answered on a stream of its own. The tunnel reconnects
// with backoff when it drops. A TLS-inspecting proxy breaks mutual TLS: when the endpoint's
// certificate is not the one expected, the agent says so, naming who issued what it was shown.
package tunnel

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"silohq.io/agent/internal/protocol"
	"silohq.io/agent/internal/spool"
)

// HeartbeatEvery is spec 10.3's interval.
const HeartbeatEvery = 10 * time.Second

// Handler runs one piece of work, emitting its result frames.
type Handler func(ctx context.Context, payload json.RawMessage, emit func(frame any) error) error

// Settings for the tunnel.
type Settings struct {
	Endpoint          string
	ServerName        string
	Roots             *x509.CertPool // nil: the system's roots
	Proxy             string
	Version           string
	DiscoveryDisabled bool
	MaxConcurrent     int
	Logger            *slog.Logger
	Handlers          map[string]Handler
	// ReplicationDSNs finds a connection's replication login for change capture.
	ReplicationDSNs ReplicationDSNs
	// Spool holds change events until the cell has them (spec 10.6).
	Spool *spool.Store
	// Telemetry runs mqtt captures (spec 20.2, 20.6): subscriptions whose messages go up as they arrive, never spooled.
	Telemetry Telemetry
	// Allowlists hold the signed actuation allow-lists (spec 47.4): taken as the cell sends them, reported in the heartbeat.
	Allowlists Allowlists
	// Monitoring runs opcua captures (spec 20.3): monitored items whose values go up as the server publishes them, never spooled.
	Monitoring Monitoring
	// Heartbeat overrides HeartbeatEvery (tests).
	Heartbeat time.Duration
}

func transport(s Settings, client *tls.Certificate) (*http.Transport, error) {
	cfg := &tls.Config{MinVersion: tls.VersionTLS13, ServerName: s.ServerName, RootCAs: s.Roots, NextProtos: []string{"h2"}}
	if client != nil {
		cfg.Certificates = []tls.Certificate{*client}
	}
	t := &http.Transport{TLSClientConfig: cfg, ForceAttemptHTTP2: true, IdleConnTimeout: 90 * time.Second, TLSHandshakeTimeout: 15 * time.Second}
	if s.Proxy != "" {
		proxy, err := url.Parse(s.Proxy)
		if err != nil {
			return nil, err
		}
		t.Proxy = http.ProxyURL(proxy)
	}
	return t, nil
}

func base(s Settings) string { return "https://" + s.Endpoint }

// inspection names who issued a certificate the endpoint should not have shown, when the
// failure is one: a TLS-inspecting proxy re-signing the connection.
func inspection(err error) (string, bool) {
	var verify *tls.CertificateVerificationError
	if errors.As(err, &verify) && len(verify.UnverifiedCertificates) > 0 {
		return verify.UnverifiedCertificates[0].Issuer.String(), true
	}
	var unknown x509.UnknownAuthorityError
	if errors.As(err, &unknown) && unknown.Cert != nil {
		return unknown.Cert.Issuer.String(), true
	}
	return "", false
}

// Enrol sends the token and signing request; the cell's answer, or why not.
func Enrol(ctx context.Context, s Settings, request protocol.EnrolRequest) (*protocol.EnrolResponse, error) {
	t, err := transport(s, nil)
	if err != nil {
		return nil, err
	}
	defer t.CloseIdleConnections()
	body, _ := json.Marshal(request)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base(s)+protocol.EnrolPath, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	res, err := (&http.Client{Transport: t, Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		if issuer, ok := inspection(err); ok {
			return nil, fmt.Errorf("the endpoint's certificate was issued by %q, not the one expected: a TLS-inspecting proxy may sit in the way, and mutual TLS cannot pass it", issuer)
		}
		return nil, fmt.Errorf("cannot reach %s: %w", s.Endpoint, err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 64*1024))
	if res.StatusCode != http.StatusCreated {
		var refusal struct {
			Error struct{ Code, Message string } `json:"error"`
		}
		_ = json.Unmarshal(raw, &refusal)
		return nil, fmt.Errorf("enrolment refused (%d %s): %s", res.StatusCode, refusal.Error.Code, refusal.Error.Message)
	}
	var enrolled protocol.EnrolResponse
	if err := json.Unmarshal(raw, &enrolled); err != nil {
		return nil, fmt.Errorf("the cell's answer does not parse: %w", err)
	}
	return &enrolled, nil
}

// Client holds the tunnel.
type Client struct {
	settings  Settings
	certMu    sync.RWMutex
	cert      tls.Certificate
	active    atomic.Int64
	connected atomic.Bool
	slots     chan struct{}
	// reconnect ends the current tunnel so the next uses the current certificate.
	reconnectMu sync.Mutex
	reconnect   context.CancelFunc
	renewing    atomic.Bool
	cdc         captures
	// root outlives each tunnel: change capture readers run on it.
	root context.Context
}

func (c *Client) certificate() tls.Certificate {
	c.certMu.RLock()
	defer c.certMu.RUnlock()
	return c.cert
}

// Renewed swaps in a new certificate and reconnects with it.
func (c *Client) Renewed(cert tls.Certificate) {
	c.certMu.Lock()
	c.cert = cert
	c.certMu.Unlock()
	c.reconnectMu.Lock()
	defer c.reconnectMu.Unlock()
	if c.reconnect != nil {
		c.renewing.Store(true)
		c.reconnect()
	}
}

// Renew asks the cell, over mutual TLS with the current certificate, for one for a new key.
func (c *Client) Renew(ctx context.Context, csr, sealingKey string) (*protocol.EnrolResponse, error) {
	current := c.certificate()
	t, err := transport(c.settings, &current)
	if err != nil {
		return nil, err
	}
	defer t.CloseIdleConnections()
	body, _ := json.Marshal(protocol.RenewRequest{CSR: csr, SealingKey: sealingKey})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base(c.settings)+protocol.RenewPath, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	res, err := (&http.Client{Transport: t, Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		return nil, fmt.Errorf("cannot reach %s to renew: %w", c.settings.Endpoint, err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 64*1024))
	if res.StatusCode != http.StatusCreated {
		var refusal struct {
			Error struct{ Code, Message string } `json:"error"`
		}
		_ = json.Unmarshal(raw, &refusal)
		return nil, fmt.Errorf("renewal refused (%d %s): %s", res.StatusCode, refusal.Error.Code, refusal.Error.Message)
	}
	var renewed protocol.EnrolResponse
	if err := json.Unmarshal(raw, &renewed); err != nil {
		return nil, fmt.Errorf("the cell's answer does not parse: %w", err)
	}
	return &renewed, nil
}

func New(s Settings, cert tls.Certificate) *Client {
	if s.MaxConcurrent < 1 {
		s.MaxConcurrent = 32
	}
	if s.Heartbeat == 0 {
		s.Heartbeat = HeartbeatEvery
	}
	return &Client{settings: s, cert: cert, slots: make(chan struct{}, s.MaxConcurrent), root: context.Background(),
		cdc: captures{readers: map[string]*reader{}, uploaders: map[string]*uploader{}, telemetry: map[string]*subscription{}}}
}

// Connected says whether the tunnel is up, for the health endpoint.
func (c *Client) Connected() bool { return c.connected.Load() }

// Active is the work in hand now.
func (c *Client) Active() int { return int(c.active.Load()) }

// Call makes one request to the cell over mutual TLS with the current certificate: the update
// routes (GET /v1/update, a binary, a report). A JSON body is sent when one is given. The caller
// reads and closes the response; done releases the connection.
func (c *Client) Call(ctx context.Context, method, path string, body any) (res *http.Response, done func(), err error) {
	current := c.certificate()
	t, err := transport(c.settings, &current)
	if err != nil {
		return nil, nil, err
	}
	var reader io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, base(c.settings)+path, reader)
	if err != nil {
		t.CloseIdleConnections()
		return nil, nil, err
	}
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	res, err = (&http.Client{Transport: t}).Do(req)
	if err != nil {
		t.CloseIdleConnections()
		return nil, nil, fmt.Errorf("cannot reach %s: %w", c.settings.Endpoint, err)
	}
	return res, func() {
		res.Body.Close()
		t.CloseIdleConnections()
	}, nil
}

// Run holds the tunnel until ctx ends, reconnecting with jittered backoff (1 s to 60 s). It
// returns early only when the cell says this agent is revoked.
func (c *Client) Run(ctx context.Context) error {
	c.root = ctx
	if c.settings.Spool != nil {
		go c.keepSpool(ctx)
	}
	backoff := time.Second
	for ctx.Err() == nil {
		started := time.Now()
		reason, err := c.once(ctx)
		c.connected.Store(false)
		// A tunnel ended to take up a renewed certificate reconnects at once.
		if c.renewing.Swap(false) && ctx.Err() == nil {
			continue
		}
		if reason == "revoked" {
			c.settings.Logger.Error("the cell revoked this agent; it will not reconnect", "event", "agent.revoked")
			return errors.New("revoked")
		}
		if ctx.Err() != nil {
			return nil
		}
		if time.Since(started) > time.Minute {
			backoff = time.Second
		}
		wait := backoff/2 + time.Duration(rand.Int64N(int64(backoff/2)+1))
		c.settings.Logger.Warn("tunnel down; reconnecting", "event", "agent.tunnel_down", "reason", describe(err, reason), "retry_in_ms", wait.Milliseconds())
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(wait):
		}
		backoff = min(backoff*2, time.Minute)
	}
	return nil
}

// keepSpool makes spooled records durable every second, keeps the spool within its bounds, and
// logs its size and gaps (spec 10.8) once a minute while it holds anything.
func (c *Client) keepSpool(ctx context.Context) {
	sync := time.NewTicker(time.Second)
	defer sync.Stop()
	logged := time.Now()
	for {
		select {
		case <-ctx.Done():
			_ = c.settings.Spool.Sync()
			return
		case <-sync.C:
		}
		if err := c.settings.Spool.Sync(); err != nil {
			c.settings.Logger.Warn("the spool could not be made durable", "event", "agent.spool_sync_failed")
		}
		if size := c.settings.Spool.Bytes(); size > 0 && time.Since(logged) > time.Minute {
			gaps := 0
			for _, slot := range c.settings.Spool.Slots() {
				if q, err := c.settings.Spool.Queue(slot); err == nil {
					gaps += len(q.Gaps())
				}
			}
			c.settings.Logger.Info("spool", "event", "agent.spool", "bytes", size, "gaps", gaps)
			logged = time.Now()
		}
	}
}

func describe(err error, reason string) string {
	if reason != "" {
		return reason
	}
	if err == nil {
		return "closed"
	}
	if issuer, ok := inspection(err); ok {
		return fmt.Sprintf("tls_inspection: the endpoint's certificate was issued by %q", issuer)
	}
	return err.Error()
}

// once holds one tunnel until it ends; the cell's close reason, if it gave one.
func (c *Client) once(ctx context.Context) (string, error) {
	current := c.certificate()
	t, err := transport(c.settings, &current)
	if err != nil {
		return "", err
	}
	defer t.CloseIdleConnections()
	client := &http.Client{Transport: t}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer c.stopUploads()
	c.reconnectMu.Lock()
	c.reconnect = cancel
	c.reconnectMu.Unlock()

	up, upWriter := io.Pipe()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base(c.settings)+protocol.TunnelPath, up)
	if err != nil {
		return "", err
	}
	req.Header.Set("content-type", "application/x-ndjson")
	frames := protocol.NewWriter(upWriter)
	var writeMu sync.Mutex
	beat := func() error {
		writeMu.Lock()
		defer writeMu.Unlock()
		reading, spooled := c.cdcState()
		beat := protocol.NewHeartbeat(c.settings.Version, int(c.active.Load()), reading, spooled, c.settings.DiscoveryDisabled)
		if c.settings.Allowlists != nil {
			beat.Allowlists = c.settings.Allowlists.Digests()
		}
		return frames.Write(beat)
	}
	// The first heartbeat goes with the request, so the cell knows the agent's load at once.
	go func() {
		if err := beat(); err != nil {
			return
		}
		ticker := time.NewTicker(c.settings.Heartbeat)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				_ = upWriter.Close()
				return
			case <-ticker.C:
				if err := beat(); err != nil {
					cancel()
					return
				}
			}
		}
	}()

	res, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(io.LimitReader(res.Body, 64*1024))
		var refusal struct {
			Error struct{ Code string } `json:"error"`
		}
		_ = json.Unmarshal(raw, &refusal)
		if refusal.Error.Code == "agent.revoked" {
			return "revoked", nil
		}
		return "", fmt.Errorf("the cell refused the tunnel (%d %s)", res.StatusCode, refusal.Error.Code)
	}
	c.connected.Store(true)
	c.settings.Logger.Info("tunnel up", "event", "agent.tunnel_up", "protocol", res.Proto)
	down := protocol.NewReader(res.Body)
	for {
		var frame protocol.Down
		if err := down.Next(&frame); err != nil {
			if errors.Is(err, io.EOF) {
				return "", nil
			}
			return "", err
		}
		switch frame.Type {
		case "close":
			c.settings.Logger.Info("the cell closed the tunnel", "event", "agent.tunnel_closed_by_cell", "reason", frame.Reason)
			return frame.Reason, nil
		case "work":
			go c.answer(ctx, client, frame)
		case "cdc.start", "cdc.ack", "cdc.gap_ack", "cdc.stop", "cdc.drop":
			c.onCapture(ctx, client, frame)
		case "allowlist":
			c.onAllowlist(frame)
		}
	}
}

// answer runs one piece of work and sends its result frames on a stream of its own.
func (c *Client) answer(ctx context.Context, client *http.Client, work protocol.Down) {
	ctx, cancel := context.WithDeadline(protocol.WithWorkID(ctx, work.ID), work.Deadline)
	defer cancel()
	body, writer := io.Pipe()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base(c.settings)+protocol.WorkPathPrefix+work.ID, body)
	if err != nil {
		return
	}
	req.Header.Set("content-type", "application/x-ndjson")
	done := make(chan struct{})
	go func() {
		defer close(done)
		// The cell answering ends the work: it has all it wants, or has given up on the rest
		// (a scan stopped), and whatever is still running stops.
		defer cancel()
		res, err := client.Do(req)
		if err != nil {
			_ = body.CloseWithError(err)
			return
		}
		_, _ = io.Copy(io.Discard, res.Body)
		res.Body.Close()
		_ = body.CloseWithError(io.ErrClosedPipe)
		if res.StatusCode != http.StatusOK {
			c.settings.Logger.Warn("the cell refused an answer", "event", "agent.answer_refused", "status", res.StatusCode, "kind", work.Kind)
		}
	}()
	frames := protocol.NewWriter(writer)
	emit := func(frame any) error { return frames.Write(frame) }
	started := time.Now()
	outcome := "done"
	select {
	case c.slots <- struct{}{}:
		c.active.Add(1)
		handler, ok := c.settings.Handlers[work.Kind]
		if !ok {
			outcome = "unknown_kind"
			_ = emit(protocol.NewError(protocol.Integrity, ""))
		} else if err := handler(ctx, work.Payload, emit); err != nil {
			outcome = "stream_failed"
		}
		c.active.Add(-1)
		<-c.slots
	default:
		// Spec 10.7: 32 concurrent calls; beyond that, refused rather than queued.
		outcome = "too_many_calls"
		_ = emit(protocol.NewError(protocol.Bounds, ""))
	}
	_ = writer.Close()
	<-done
	// Counts and outcome only: never a statement, a value or a row (spec 10.8).
	c.settings.Logger.Info("work answered", "event", "agent.work", "kind", work.Kind, "outcome", outcome, "duration_ms", time.Since(started).Milliseconds())
}

// LoadRoots reads a PEM file of certificate authorities for the endpoint, or nil for the system's.
func LoadRoots(path string) (*x509.CertPool, error) {
	if path == "" {
		return nil, nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(raw) {
		return nil, fmt.Errorf("%s holds no certificate", path)
	}
	return pool, nil
}

// Allowlists are the signed actuation allow-lists this agent holds (package actuation).
type Allowlists interface {
	Replace(connectionID string, entries []protocol.SignedEntry) string
	Digests() []protocol.AllowlistDigest
}

// onAllowlist takes a connection's signed allow-list, or keeps the one held and says why not.
// A refused list must not happen in normal operation: the cell signed what it sent.
func (c *Client) onAllowlist(frame protocol.Down) {
	if c.settings.Allowlists == nil {
		return
	}
	if reason := c.settings.Allowlists.Replace(frame.ConnectionID, frame.Entries); reason != "" {
		c.settings.Logger.Warn("an actuation allow-list was refused; the one held stays", "event", "agent.allowlist_refused",
			"connection_id", frame.ConnectionID, "reason", reason)
		return
	}
	c.settings.Logger.Info("an actuation allow-list was taken", "event", "agent.allowlist_taken", "connection_id", frame.ConnectionID, "entries", len(frame.Entries))
}
