package work

// MQTT (spec 20.2), the agent's industrial plugin: the broker is reached locally from the
// customer's network and the results go up the tunnel, so no inbound rule is added.
//
// mqtt.snapshot is a read: the retained messages on the manifest's topic filters, gathered for
// a window, as the backfill of what the broker holds (18.5). Each becomes a row: the topic,
// the payload (base64; the cell decodes it with the manifest's JSONata), whether it was
// retained, and when the agent received it. More than maxMessages is reported truncated,
// never silently cut.
//
// The endpoint comes from the cell; its host must be one the host's owner allows (the same
// targets as every other login, spec 10.7): any other is refused as target_refused. A login
// the cell seals (username and password) opens only for this work. paho takes the password as
// a Go string for the connect call alone; the sealed bytes are wiped when the work ends.

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/netip"
	"net/url"
	"strings"
	"sync"
	"time"

	paho "github.com/eclipse/paho.mqtt.golang"

	"silohq.io/agent/internal/actuation"
	"silohq.io/agent/internal/grant"
	"silohq.io/agent/internal/login"
	"silohq.io/agent/internal/protocol"
)

const (
	maxMQTTWindow   = 10 * time.Second
	maxMQTTMessages = 100_000
)

// MQTT runs the MQTT plugin's work.
type MQTT struct {
	logins  *login.Opener
	targets login.Targets
	// Resolve finds a broker's addresses (tests replace it).
	Resolve func(context.Context, string) ([]netip.Addr, error)
	// Roots verifies an ssl:// broker; the system's roots when nil.
	Roots *x509.CertPool
	// Grants check a command's execution grant; Allowlists hold the signed allow-lists it must be in (47.4).
	Grants     *grant.Verifier
	Allowlists *actuation.Store
	writes     *writeLog
}

// NewMQTT opens logins with logins, for the brokers targets allows.
func NewMQTT(logins *login.Opener, targets login.Targets) *MQTT {
	return &MQTT{logins: logins, targets: targets, writes: &writeLog{last: map[string]time.Time{}, recent: map[string][]time.Time{}}}
}

type mqttEndpoint struct {
	tls  bool
	host string
	port string
}

func parseMQTTEndpoint(raw string) (mqttEndpoint, bool) {
	u, err := url.Parse(raw)
	if err != nil || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" {
		return mqttEndpoint{}, false
	}
	secure := false
	switch u.Scheme {
	case "tcp", "mqtt":
	case "ssl", "mqtts", "tls":
		secure = true
	default:
		return mqttEndpoint{}, false
	}
	port := u.Port()
	if port == "" {
		port = "1883"
		if secure {
			port = "8883"
		}
	}
	return mqttEndpoint{tls: secure, host: u.Hostname(), port: port}, u.Hostname() != ""
}

// validFilter is an MQTT topic filter: + a whole level, # the last level alone.
func validFilter(filter string) bool {
	if filter == "" || len(filter) > 1024 || strings.ContainsRune(filter, 0) {
		return false
	}
	levels := strings.Split(filter, "/")
	for i, level := range levels {
		if strings.Contains(level, "#") && (level != "#" || i != len(levels)-1) {
			return false
		}
		if strings.Contains(level, "+") && level != "+" {
			return false
		}
	}
	return true
}

// session is a connected client and what to release when it ends; or the error frame saying why not.
type brokerSession struct {
	client paho.Client
	login  *login.Login
}

func (s *brokerSession) close() {
	s.client.Disconnect(250)
	s.login.Zero()
}

// connect checks the broker against the targets, opens the sealed login for this work, and
// connects with a clean session under clientID.
func (m *MQTT) connect(ctx context.Context, endpointURL string, topics []protocol.MQTTTopic, sealed *protocol.SealedLogin,
	connectionID, workID, clientID string, onLost func()) (*brokerSession, *protocol.Error) {
	integrity := protocol.NewError(protocol.Integrity, "")
	endpoint, ok := parseMQTTEndpoint(endpointURL)
	if !ok || len(topics) == 0 {
		return nil, &integrity
	}
	for _, t := range topics {
		if !validFilter(t.Filter) || t.QoS > 2 {
			return nil, &integrity
		}
	}
	addrs, allowed := m.targets.Allow(ctx, endpoint.host, m.Resolve)
	if !allowed {
		refusal := protocol.Error{Type: "error", Category: protocol.TargetRefused}
		return nil, &refusal
	}
	var opened *login.Login
	if sealed != nil {
		if m.logins == nil {
			refusal := refused(login.RefusedNoKey)
			return nil, &refusal
		}
		l, reason := m.logins.Open(sealed, connectionID, workID, time.Now())
		if reason != "" {
			refusal := refused(reason)
			return nil, &refusal
		}
		opened = l
	}
	// The broker by name where the owner allows the name, else at the addresses it resolved to.
	host := endpoint.host
	if len(addrs) > 0 {
		host = addrs[0]
	}
	scheme := "tcp"
	if endpoint.tls {
		scheme = "ssl"
	}
	options := paho.NewClientOptions().
		AddBroker(fmt.Sprintf("%s://%s", scheme, net.JoinHostPort(host, endpoint.port))).
		SetClientID(clientID).
		SetCleanSession(true).
		SetAutoReconnect(false).
		SetConnectRetry(false).
		SetConnectTimeout(10 * time.Second).
		SetOrderMatters(false)
	if onLost != nil {
		options.SetConnectionLostHandler(func(paho.Client, error) { onLost() })
	}
	if endpoint.tls {
		options.SetTLSConfig(&tls.Config{MinVersion: tls.VersionTLS12, RootCAs: m.Roots, ServerName: endpoint.host})
	}
	if opened != nil {
		options.SetUsername(opened.User)
		if opened.Password != nil {
			options.SetPassword(string(opened.Password.Bytes()))
		}
	}
	client := paho.NewClient(options)
	token := client.Connect()
	if !token.WaitTimeout(15*time.Second) || token.Error() != nil {
		opened.Zero()
		if token.Error() != nil {
			text := strings.ToLower(token.Error().Error())
			if strings.Contains(text, "not authori") || strings.Contains(text, "bad user name or password") {
				refusal := protocol.Error{Type: "error", Category: protocol.SourceRefused, Reason: protocol.RefusedLogin}
				return nil, &refusal
			}
		}
		unreachable := protocol.NewError(protocol.SourceUnreachable, "")
		return nil, &unreachable
	}
	return &brokerSession{client: client, login: opened}, nil
}

func messageRow(msg paho.Message) map[string]any {
	return map[string]any{
		"topic": msg.Topic(), "payload": base64.StdEncoding.EncodeToString(msg.Payload()), "retained": msg.Retained(),
		"receivedAt": time.Now().UTC().Format(time.RFC3339Nano),
	}
}

// Snapshot runs an mqtt.snapshot and emits its messages as rows, then done; or one error frame.
func (m *MQTT) Snapshot(ctx context.Context, payload json.RawMessage, emit Emit) error {
	var snap protocol.MQTTSnapshot
	if err := json.NewDecoder(bytes.NewReader(payload)).Decode(&snap); err != nil || len(snap.Topics) == 0 {
		return emit(protocol.NewError(protocol.Integrity, ""))
	}
	window := time.Duration(snap.WindowMs) * time.Millisecond
	if window <= 0 || window > maxMQTTWindow {
		window = 2 * time.Second
	}
	limit := snap.MaxMessages
	if limit <= 0 || limit > maxMQTTMessages {
		limit = maxMQTTMessages
	}
	sess, refusal := m.connect(ctx, snap.EndpointURL, snap.Topics, snap.Credential, snap.ConnectionID, protocol.WorkID(ctx),
		"silo-"+strings.ReplaceAll(protocol.WorkID(ctx), "-", ""), nil)
	if refusal != nil {
		return emit(*refusal)
	}
	defer sess.close()
	client := sess.client
	var (
		mu        sync.Mutex
		rows      []map[string]any
		truncated bool
		full      = make(chan struct{})
		once      sync.Once
	)
	handler := func(_ paho.Client, msg paho.Message) {
		// Retained messages are the backfill; a live publish during the window is not a snapshot's.
		if !msg.Retained() {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		if len(rows) >= limit {
			truncated = true
			once.Do(func() { close(full) })
			return
		}
		rows = append(rows, messageRow(msg))
	}
	filters := make(map[string]byte, len(snap.Topics))
	for _, t := range snap.Topics {
		filters[t.Filter] = t.QoS
	}
	sub := client.SubscribeMultiple(filters, handler)
	if !sub.WaitTimeout(10*time.Second) || sub.Error() != nil {
		return emit(protocol.NewError(protocol.SourceRefused, ""))
	}
	select {
	case <-time.After(window):
	case <-full:
	case <-ctx.Done():
		return emit(protocol.NewError(protocol.Timeout, ""))
	}
	mu.Lock()
	collected, cut := rows, truncated
	rows = nil
	mu.Unlock()
	for start := 0; start < len(collected); start += protocol.RowsPerFrame {
		end := min(start+protocol.RowsPerFrame, len(collected))
		if err := emit(protocol.NewRows(collected[start:end])); err != nil {
			return err
		}
	}
	return emit(protocol.NewDone(len(collected), cut))
}

// subscribeBatch is how many messages go up in one frame, and how long the first waits for company.
const (
	subscribeBatch = 500
	subscribeFlush = 200 * time.Millisecond
)

// Subscribe runs an mqtt capture (spec 20.2, 20.6): connects, subscribes to every filter, says
// started, and delivers messages in small batches as they arrive (a retained one first, the
// backfill of 18.5), until ctx ends or the broker goes. Nothing is kept: a batch the cell does
// not take ends the subscription. The returned error frame says why it ended, nil when ctx did.
func (m *MQTT) Subscribe(ctx context.Context, connectionID, slotID string, sub *protocol.MQTTCapture, started func() error,
	deliver func(messages []map[string]any) error) *protocol.Error {
	if sub == nil {
		integrity := protocol.NewError(protocol.Integrity, "")
		return &integrity
	}
	lost := make(chan struct{})
	var lostOnce sync.Once
	sess, refusal := m.connect(ctx, sub.EndpointURL, sub.Topics, sub.Credential, connectionID, slotID,
		"silo-"+strings.ReplaceAll(slotID, "-", ""), func() { lostOnce.Do(func() { close(lost) }) })
	if refusal != nil {
		return refusal
	}
	defer sess.close()
	incoming := make(chan map[string]any, 4*subscribeBatch)
	var dropped sync.Once
	full := make(chan struct{})
	filters := make(map[string]byte, len(sub.Topics))
	for _, t := range sub.Topics {
		filters[t.Filter] = t.QoS
	}
	token := sess.client.SubscribeMultiple(filters, func(_ paho.Client, msg paho.Message) {
		select {
		case incoming <- messageRow(msg):
		default:
			// The cell is not keeping up: telemetry is never queued on disk, so the subscription ends and is offered again.
			dropped.Do(func() { close(full) })
		}
	})
	if !token.WaitTimeout(10*time.Second) || token.Error() != nil {
		refusal := protocol.NewError(protocol.SourceRefused, "")
		return &refusal
	}
	if err := started(); err != nil {
		return nil
	}
	batch := make([]map[string]any, 0, subscribeBatch)
	flush := time.NewTimer(subscribeFlush)
	defer flush.Stop()
	send := func() bool {
		if len(batch) == 0 {
			return true
		}
		if err := deliver(batch); err != nil {
			return false
		}
		batch = make([]map[string]any, 0, subscribeBatch)
		return true
	}
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-lost:
			unreachable := protocol.NewError(protocol.SourceUnreachable, "")
			return &unreachable
		case <-full:
			capacity := protocol.NewError(protocol.Capacity, "")
			return &capacity
		case row := <-incoming:
			batch = append(batch, row)
			if len(batch) >= subscribeBatch && !send() {
				return nil
			}
		case <-flush.C:
			if !send() {
				return nil
			}
			flush.Reset(subscribeFlush)
		}
	}
}
