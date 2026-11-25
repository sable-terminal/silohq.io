// HTTP (spec 20.4): an outbound webhook to a private target, sent from the customer's network.
//
// The request travels as the one statement of a write, as SQL's do: a POST runs only on a
// signed execution grant from the cell's actions naming the connection, one statement, and the
// SHA-256 of the statements exactly as they arrived (package grant), and a grant runs once. A GET reads a webhook's declared status endpoint (the effect,
// not the delivery) and needs no grant. Either reaches only a host the host's owner allows
// (configuration `targets`), at the addresses allowed, so a name cannot point elsewhere
// afterwards; over HTTPS with this host's trust store; never following a redirect; with the
// few headers a webhook carries. The answer is the status code, and for a status endpoint the
// state it reports: never a body, which is read up to a bound and discarded.
//
// A physical target's POST (spec 47.1, 47.4, 47.5) names its action: it is sent only if this
// agent's current signed allow-list for the connection lists the action as a webhook command,
// its last accepted send at least the entry's interval ago and the connection within its
// physical writes a minute; otherwise it is refused (actuation_refused), whatever the cell asks.
package work

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"

	"silohq.io/agent/internal/actuation"
	"silohq.io/agent/internal/grant"
	"silohq.io/agent/internal/login"
	"silohq.io/agent/internal/protocol"
)

// maxBody bounds what is read of an answer: enough for a status endpoint's state.
const maxBody = 4 * 1024

// allowedHeaders are the headers a webhook request may carry; others are refused.
var allowedHeaders = map[string]bool{
	"content-type": true, "user-agent": true, "idempotency-key": true,
	"silo-delivery-id": true, "silo-timestamp": true, "silo-signature": true,
}

// HTTPRequest is the request as the cell sends it, and as its grant hashes it.
type HTTPRequest struct {
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
	// Physical is a physical target's (47.4): its action's name and the connection's writes a minute (0: none set).
	Physical *httpPhysical `json:"physical,omitempty"`
}

type httpPhysical struct {
	Action       string `json:"action"`
	MaxPerMinute int    `json:"maxPerMinute"`
}

type httpWork struct {
	ConnectionID string          `json:"connectionId"`
	Grant        *grant.Signed   `json:"grant"`
	Statements   json.RawMessage `json:"statements"`
}

// HTTPResult is the answer: the status code, and a status endpoint's reported state.
type HTTPResult struct {
	Type   string `json:"type"`
	Status int    `json:"status"`
	State  string `json:"state,omitempty"`
}

// HTTP sends webhook requests for the cell.
type HTTP struct {
	grants  *grant.Verifier
	targets login.Targets
	// Resolve finds a host's addresses; nil uses the system resolver (tests replace it).
	Resolve func(context.Context, string) ([]netip.Addr, error)
	// Roots are the certificate authorities trusted; nil is the system's (tests replace it).
	Roots *x509.CertPool
	// Allowlists hold the signed allow-lists a physical target's action must be in (47.4).
	Allowlists *actuation.Store
	writes     *writeLog
}

func NewHTTP(grants *grant.Verifier, targets login.Targets) *HTTP {
	return &HTTP{grants: grants, targets: targets, writes: &writeLog{last: map[string]time.Time{}, recent: map[string][]time.Time{}}}
}

// physicalRefusal says why a physical target's POST may not be sent now, or "".
func (h *HTTP) physicalRefusal(connectionID string, p *httpPhysical, at time.Time) string {
	entry, listed := actuation.Entry{}, false
	if h.Allowlists != nil {
		entry, listed = h.Allowlists.Lookup(connectionID, "webhook", p.Action)
	}
	if !listed {
		return "not_listed"
	}
	if reason := commandAllowed(h.writes, connectionID, p.Action, entry, []string{"command"}, false, at); reason != "" {
		return reason
	}
	if p.MaxPerMinute > 0 && h.writes.inLastMinute(connectionID, at)+1 > p.MaxPerMinute {
		return "rate"
	}
	return ""
}

func httpRefused(category, reason string) protocol.Error {
	return protocol.Error{Type: "error", Category: category, Reason: reason}
}

// Send runs one request (work kind http.send).
func (h *HTTP) Send(ctx context.Context, payload json.RawMessage, emit Emit) error {
	var w httpWork
	var statements []HTTPRequest
	if json.Unmarshal(payload, &w) != nil || json.Unmarshal(w.Statements, &statements) != nil || len(statements) != 1 {
		return emit(protocol.NewError(protocol.Integrity, ""))
	}
	req := statements[0]
	switch req.Method {
	case http.MethodPost:
		if w.Grant == nil {
			return emit(httpRefused(protocol.GrantRefused, "unsigned"))
		}
		if _, reason := h.grants.Check(w.Grant, w.ConnectionID, w.Statements, 1); reason != "" {
			return emit(httpRefused(protocol.GrantRefused, reason))
		}
	case http.MethodGet:
		if req.Body != "" || req.Physical != nil {
			return emit(protocol.NewError(protocol.Integrity, ""))
		}
	default:
		return emit(protocol.NewError(protocol.Integrity, ""))
	}
	target, err := url.Parse(req.URL)
	if err != nil || target.Scheme != "https" || target.User != nil || target.Hostname() == "" {
		return emit(protocol.NewError(protocol.Integrity, ""))
	}
	for name := range req.Headers {
		if !allowedHeaders[strings.ToLower(name)] {
			return emit(protocol.NewError(protocol.Integrity, ""))
		}
	}
	addrs, allowed := h.targets.Allow(ctx, target.Hostname(), h.Resolve)
	if !allowed {
		return emit(httpRefused(protocol.TargetRefused, "target"))
	}
	if req.Physical != nil {
		if reason := h.physicalRefusal(w.ConnectionID, req.Physical, time.Now()); reason != "" {
			return emit(httpRefused(protocol.ActuationRefused, reason))
		}
	}
	port := target.Port()
	if port == "" {
		port = "443"
	}
	dialer := &net.Dialer{Timeout: 10 * time.Second}
	transport := &http.Transport{
		// Allowed by name: reached by name. Otherwise only at the addresses that were allowed.
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			if addrs == nil {
				return dialer.DialContext(ctx, network, net.JoinHostPort(target.Hostname(), port))
			}
			var last error
			for _, addr := range addrs {
				conn, err := dialer.DialContext(ctx, network, net.JoinHostPort(addr, port))
				if err == nil {
					return conn, nil
				}
				last = err
			}
			return nil, last
		},
		TLSClientConfig:       &tls.Config{ServerName: target.Hostname(), RootCAs: h.Roots, MinVersion: tls.VersionTLS12},
		ResponseHeaderTimeout: 30 * time.Second,
		Proxy:                 nil,
		DisableKeepAlives:     true,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	var body io.Reader
	if req.Method == http.MethodPost {
		body = bytes.NewReader([]byte(req.Body))
	}
	r, err := http.NewRequestWithContext(ctx, req.Method, target.String(), body)
	if err != nil {
		return emit(protocol.NewError(protocol.Integrity, ""))
	}
	for name, value := range req.Headers {
		r.Header.Set(name, value)
	}
	res, err := client.Do(r)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return emit(protocol.NewError(protocol.Timeout, ""))
		}
		return emit(protocol.NewError(protocol.SourceUnreachable, ""))
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, maxBody))
	result := HTTPResult{Type: "http_result", Status: res.StatusCode}
	// Accepted by the target: the physical write counts against the entry's interval and the rate.
	if req.Physical != nil && res.StatusCode >= 200 && res.StatusCode < 300 {
		h.writes.wrote(w.ConnectionID, req.Physical.Action, time.Now())
	}
	if req.Method == http.MethodGet && res.StatusCode >= 200 && res.StatusCode < 300 {
		var reported struct {
			State string `json:"state"`
		}
		if json.Unmarshal(raw, &reported) == nil {
			switch reported.State {
			case "applied", "pending", "failed":
				result.State = reported.State
			}
		}
	}
	return emit(result)
}
