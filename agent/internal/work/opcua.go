package work

// OPC UA (spec 20.3), the agent's industrial plugin: the server is reached locally from the
// customer's network and results go up the tunnel.
//
// opcua.read is a read: the root node's child objects are the records (of a type definition
// where the manifest names one), and each field is the value of the variable at its browse path
// under the instance ("Temperature", "Motor/Speed"), or the instance's own browse name or node
// address ($browseName, $nodeId). Paths are resolved by browsing hierarchical references, which
// every server answers. Nodes are named by namespace URI plus identifier, never by namespace
// index, which can change on restart: the agent maps URIs to the server's indexes as it finds
// them. More instances than maxInstances are reported truncated, never silently cut.
//
// opcua.probe connects as a read would and reports the server's namespaces and certificate: the
// owner's check that the server trusts the application certificate.
//
// Monitor runs an opcua capture: it connects as a read would, finds each streamed object's
// instances and the variables at its fields' browse paths, and makes one subscription with a
// monitored item per instance and path (the manifest's sampling interval, queue size and
// deadband). The server's first notification of each item is the backfill; values then go up as
// it publishes them, never spooled. When the session ends, so does the capture, and the cell
// leases it again.
//
// The endpoint comes from the cell and its host must be one the host's owner allows. Security
// is None (which the cell allows only where the connection's owner recorded the exception for a
// segregated network) or a current policy with Sign or SignAndEncrypt. For a signed policy the
// agent asks the server for its endpoints, takes the one with that policy and mode, and refuses
// a server whose certificate is not the one the owner pinned before opening the channel; it then
// connects as the endpoint's application, with the certificate the cell sends and the key the
// cell seals for this work, which opens for no other. A login the cell seals opens the same way.

import (
	"bytes"
	"context"
	"crypto/rsa"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gopcua/opcua"
	"github.com/gopcua/opcua/id"
	"github.com/gopcua/opcua/ua"

	"silohq.io/agent/internal/actuation"
	"silohq.io/agent/internal/grant"
	"silohq.io/agent/internal/login"
	"silohq.io/agent/internal/protocol"
)

const (
	maxOPCUAInstances = 10_000
	maxOPCUAPaths     = 500
	opcuaReadChunk    = 500
)

// OPCUA runs the OPC UA plugin's work.
type OPCUA struct {
	logins  *login.Opener
	targets login.Targets
	// Resolve finds a server's addresses (tests replace it).
	Resolve func(context.Context, string) ([]netip.Addr, error)
	// Grants check a physical write's execution grant; Allowlists hold the signed allow-lists it
	// must be in (spec 47.4). Without them every write is refused.
	Grants     *grant.Verifier
	Allowlists *actuation.Store
	writes     *writeLog
}

// NewOPCUA opens logins with logins, for the servers targets allows.
func NewOPCUA(logins *login.Opener, targets login.Targets) *OPCUA {
	return &OPCUA{logins: logins, targets: targets, writes: &writeLog{last: map[string]time.Time{}, recent: map[string][]time.Time{}}}
}

var nodeAddress = regexp.MustCompile(`^nsu=([^;\s]{1,500});((?:i=\d{1,10})|(?:s=\S{1,500})|(?:g=[0-9a-fA-F-]{36})|(?:b=[A-Za-z0-9+/=]{1,700}))$`)

// parseNodeAddress splits "nsu=<uri>;<id>" into the namespace URI and the identifier part.
func parseNodeAddress(address string) (uri, identifier string, ok bool) {
	m := nodeAddress.FindStringSubmatch(address)
	if m == nil {
		return "", "", false
	}
	return m[1], m[2], true
}

func parseOPCUAEndpoint(raw string) (host, port, path string, ok bool) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "opc.tcp" || u.User != nil || u.RawQuery != "" || u.Hostname() == "" {
		return "", "", "", false
	}
	port = u.Port()
	if port == "" {
		port = "4840"
	}
	return u.Hostname(), port, u.Path, true
}

// validPath is a browse path of browse names separated by /, or $browseName or $nodeId.
func validPath(path string) bool {
	if path == "$browseName" || path == "$nodeId" {
		return true
	}
	if path == "" || len(path) > 1_000 {
		return false
	}
	for _, segment := range strings.Split(path, "/") {
		if segment == "" || strings.ContainsRune(segment, 0) {
			return false
		}
	}
	return true
}

// jsonValue is a variant's value as JSON carries it: numbers and text as they are, a time as
// RFC 3339, bytes as base64, localised text as its text.
func jsonValue(v *ua.Variant) any {
	if v == nil {
		return nil
	}
	switch value := v.Value().(type) {
	case nil:
		return nil
	case time.Time:
		return value.UTC().Format(time.RFC3339Nano)
	case []byte:
		return base64.StdEncoding.EncodeToString(value)
	case *ua.LocalizedText:
		return value.Text
	case *ua.QualifiedName:
		return value.Name
	case *ua.NodeID:
		return value.String()
	case bool, string, float32, float64, int8, int16, int32, int64, uint8, uint16, uint32, uint64:
		return value
	default:
		return fmt.Sprint(value)
	}
}

type opcuaSession struct {
	client     *opcua.Client
	namespaces []string
}

// address is a node's address by namespace URI, as the manifest names nodes.
func (s *opcuaSession) address(node *ua.NodeID) string {
	ns := int(node.Namespace())
	text := node.String()
	if i := strings.Index(text, ";"); strings.HasPrefix(text, "ns=") && i > 0 {
		text = text[i+1:]
	}
	if ns < len(s.namespaces) {
		return "nsu=" + s.namespaces[ns] + ";" + text
	}
	return text
}

// resolve is a manifest address on this server, its URI mapped to the server's index now.
func (s *opcuaSession) resolve(address string) (*ua.NodeID, bool) {
	uri, identifier, ok := parseNodeAddress(address)
	if !ok {
		return nil, false
	}
	for i, ns := range s.namespaces {
		if ns == uri {
			node, err := ua.ParseNodeID("ns=" + strconv.Itoa(i) + ";" + identifier)
			return node, err == nil
		}
	}
	return nil, false
}

type child struct {
	id         *ua.NodeID
	browseName string
	typeDef    *ua.NodeID
}

// children are a node's hierarchical children, objects and variables, by browse name.
func (s *opcuaSession) children(ctx context.Context, node *ua.NodeID) ([]child, error) {
	refs, err := s.client.Node(node).References(ctx, id.HierarchicalReferences, ua.BrowseDirectionForward, ua.NodeClassObject|ua.NodeClassVariable, true)
	if err != nil {
		return nil, err
	}
	out := make([]child, 0, len(refs))
	for _, ref := range refs {
		if ref.NodeID == nil || ref.NodeID.NodeID == nil || ref.BrowseName == nil {
			continue
		}
		c := child{id: ref.NodeID.NodeID, browseName: ref.BrowseName.Name}
		if ref.TypeDefinition != nil {
			c.typeDef = ref.TypeDefinition.NodeID
		}
		out = append(out, c)
	}
	return out, nil
}

// Read runs an opcua.read and emits a row per instance, then done; or one error frame.
func (o *OPCUA) Read(ctx context.Context, payload json.RawMessage, emit Emit) error {
	var read protocol.OPCUARead
	if err := json.NewDecoder(bytes.NewReader(payload)).Decode(&read); err != nil {
		return emit(protocol.NewError(protocol.Integrity, ""))
	}
	if len(read.Paths) == 0 || len(read.Paths) > maxOPCUAPaths {
		return emit(protocol.NewError(protocol.Integrity, ""))
	}
	if _, _, ok := parseNodeAddress(read.Root); !ok {
		return emit(protocol.NewError(protocol.Integrity, ""))
	}
	if read.TypeDefinition != "" {
		if _, _, ok := parseNodeAddress(read.TypeDefinition); !ok {
			return emit(protocol.NewError(protocol.Integrity, ""))
		}
	}
	for _, p := range read.Paths {
		if !validPath(p) {
			return emit(protocol.NewError(protocol.Integrity, ""))
		}
	}
	limit := read.MaxInstances
	if limit <= 0 || limit > maxOPCUAInstances {
		limit = maxOPCUAInstances
	}
	sess, _, failure := o.connect(ctx, read.OPCUAServer)
	if failure != nil {
		return emit(*failure)
	}
	defer sess.client.Close(context.Background())
	client := sess.client
	root, ok := sess.resolve(read.Root)
	if !ok {
		// The namespace is not on the server: the root is not found.
		return emit(protocol.NewError(protocol.SourceRefused, ""))
	}
	var typeDef *ua.NodeID
	if read.TypeDefinition != "" {
		if typeDef, ok = sess.resolve(read.TypeDefinition); !ok {
			return emit(protocol.NewError(protocol.SourceRefused, ""))
		}
	}
	instances, err := sess.children(ctx, root)
	if err != nil {
		return emit(protocol.NewError(protocol.SourceRefused, ""))
	}
	rows := make([]map[string]any, 0, len(instances))
	truncated := false
	for _, instance := range instances {
		if typeDef != nil && (instance.typeDef == nil || instance.typeDef.String() != typeDef.String()) {
			continue
		}
		if len(rows) >= limit {
			truncated = true
			break
		}
		row := map[string]any{}
		var reads []*ua.ReadValueID
		var fields []string
		cache := map[string][]child{}
		for _, p := range read.Paths {
			switch p {
			case "$browseName":
				row[p] = instance.browseName
				continue
			case "$nodeId":
				row[p] = sess.address(instance.id)
				continue
			}
			// <path>/$nodeId is the address of the node at path: what a physical write would name (47.3).
			if prefix, isAddress := strings.CutSuffix(p, "/$nodeId"); isAddress {
				node, found, err := sess.walk(ctx, instance.id, prefix)
				if err == nil && !found {
					// A method a physical command calls (47.1) is addressed the same way.
					_, node, err = sess.methodNode(ctx, instance.id, prefix)
					found = node != nil
				}
				if err != nil {
					return emit(protocol.NewError(protocol.SourceRefused, ""))
				}
				row[p] = nil
				if found {
					row[p] = sess.address(node)
				}
				continue
			}
			node := instance.id
			found := true
			for _, segment := range strings.Split(p, "/") {
				key := node.String()
				kids, seen := cache[key]
				if !seen {
					if kids, err = sess.children(ctx, node); err != nil {
						return emit(protocol.NewError(protocol.SourceRefused, ""))
					}
					cache[key] = kids
				}
				next := (*ua.NodeID)(nil)
				for _, k := range kids {
					if k.browseName == segment {
						next = k.id
						break
					}
				}
				if next == nil {
					found = false
					break
				}
				node = next
			}
			if !found {
				row[p] = nil
				continue
			}
			reads = append(reads, &ua.ReadValueID{NodeID: node, AttributeID: ua.AttributeIDValue})
			fields = append(fields, p)
		}
		for start := 0; start < len(reads); start += opcuaReadChunk {
			end := min(start+opcuaReadChunk, len(reads))
			res, err := client.Read(ctx, &ua.ReadRequest{NodesToRead: reads[start:end], TimestampsToReturn: ua.TimestampsToReturnBoth})
			if err != nil || len(res.Results) != end-start {
				return emit(protocol.NewError(protocol.SourceRefused, ""))
			}
			for i, result := range res.Results {
				if result.Status != ua.StatusOK {
					row[fields[start+i]] = nil
					continue
				}
				row[fields[start+i]] = jsonValue(result.Value)
			}
		}
		rows = append(rows, row)
	}
	for start := 0; start < len(rows); start += protocol.RowsPerFrame {
		end := min(start+protocol.RowsPerFrame, len(rows))
		if err := emit(protocol.NewRows(rows[start:end])); err != nil {
			return err
		}
	}
	return emit(protocol.NewDone(len(rows), truncated))
}

// Probe runs an opcua.probe: connect, then one row with the server's namespaces and the
// certificate it presented, then done; or one error frame.
func (o *OPCUA) Probe(ctx context.Context, payload json.RawMessage, emit Emit) error {
	var probe protocol.OPCUAProbe
	if err := json.NewDecoder(bytes.NewReader(payload)).Decode(&probe); err != nil {
		return emit(protocol.NewError(protocol.Integrity, ""))
	}
	sess, presented, failure := o.connect(ctx, probe.OPCUAServer)
	if failure != nil {
		return emit(*failure)
	}
	defer sess.client.Close(context.Background())
	row := map[string]any{"namespaceUris": sess.namespaces}
	if presented != nil {
		sha := sha1.Sum(presented)
		sum := sha256.Sum256(presented)
		row["serverSha1"] = hex.EncodeToString(sha[:])
		row["serverSha256"] = hex.EncodeToString(sum[:])
	}
	if err := emit(protocol.NewRows([]map[string]any{row})); err != nil {
		return err
	}
	return emit(protocol.NewDone(1, false))
}

// security splits "None" or "<policy> <Sign|SignAndEncrypt>" into the policy's URI and the mode.
func security(policy string) (uri string, mode ua.MessageSecurityMode, ok bool) {
	if policy == "None" {
		return ua.SecurityPolicyURINone, ua.MessageSecurityModeNone, true
	}
	name, modeName, found := strings.Cut(policy, " ")
	if !found {
		return "", 0, false
	}
	switch name {
	case "Basic256Sha256", "Aes128_Sha256_RsaOaep", "Aes256_Sha256_RsaPss":
	default:
		return "", 0, false
	}
	switch modeName {
	case "Sign":
		mode = ua.MessageSecurityModeSign
	case "SignAndEncrypt":
		mode = ua.MessageSecurityModeSignAndEncrypt
	default:
		return "", 0, false
	}
	return ua.SecurityPolicyURIPrefix + name, mode, true
}

var thumbprintPattern = regexp.MustCompile(`^([0-9a-f]{40}|[0-9a-f]{64})$`)

// serverPinned is whether the server's leaf certificate is the one the owner pinned, by SHA-1 or SHA-256.
func serverPinned(leaf []byte, thumbprint string) bool {
	want, err := hex.DecodeString(thumbprint)
	if err != nil {
		return false
	}
	var got []byte
	if len(want) == sha1.Size {
		sum := sha1.Sum(leaf)
		got = sum[:]
	} else {
		sum := sha256.Sum256(leaf)
		got = sum[:]
	}
	return subtle.ConstantTimeCompare(got, want) == 1
}

// untrustedCodes are a server's answers when it does not accept the application certificate,
// or the channel's security, as it stands.
var untrustedCodes = map[ua.StatusCode]bool{
	ua.StatusBadSecurityChecksFailed: true, ua.StatusBadCertificateUntrusted: true, ua.StatusBadCertificateInvalid: true,
	ua.StatusBadCertificateTimeInvalid: true, ua.StatusBadCertificateURIInvalid: true, ua.StatusBadCertificateUseNotAllowed: true,
	ua.StatusBadCertificateRevoked: true, ua.StatusBadCertificateIssuerRevoked: true, ua.StatusBadCertificateRevocationUnknown: true,
	ua.StatusBadCertificateIssuerTimeInvalid: true, ua.StatusBadCertificateIssuerUseNotAllowed: true,
	ua.StatusBadCertificateIssuerRevocationUnknown: true, ua.StatusBadSecurityPolicyRejected: true,
}

// loginCodes are a server's answers to a login it does not accept.
var loginCodes = map[ua.StatusCode]bool{
	ua.StatusBadIdentityTokenInvalid: true, ua.StatusBadIdentityTokenRejected: true, ua.StatusBadUserAccessDenied: true,
}

func sourceRefused(reason string) *protocol.Error {
	return &protocol.Error{Type: "error", Category: protocol.SourceRefused, Reason: reason}
}

func failed(category string) *protocol.Error {
	e := protocol.NewError(category, "")
	return &e
}

// connect opens a session on the server as the work says: its security, the server's pinned
// certificate, the application's certificate and key, and the login. The session's namespaces
// are read; for a signed policy, the server's leaf certificate is returned too.
func (o *OPCUA) connect(ctx context.Context, server protocol.OPCUAServer, onLost ...func()) (*opcuaSession, []byte, *protocol.Error) {
	host, port, path, ok := parseOPCUAEndpoint(server.EndpointURL)
	if !ok {
		return nil, nil, failed(protocol.Integrity)
	}
	policyURI, mode, ok := security(server.SecurityPolicy)
	if !ok {
		return nil, nil, failed(protocol.Integrity)
	}
	signed := mode != ua.MessageSecurityModeNone
	var certificate []byte
	if signed {
		var err error
		if certificate, err = base64.StdEncoding.DecodeString(server.Certificate); err != nil || len(certificate) == 0 ||
			!thumbprintPattern.MatchString(server.ServerThumbprint) || server.ApplicationKey == nil {
			return nil, nil, failed(protocol.Integrity)
		}
	}
	addrs, allowed := o.targets.Allow(ctx, host, o.Resolve)
	if !allowed {
		return nil, nil, &protocol.Error{Type: "error", Category: protocol.TargetRefused}
	}
	// The server by name where the owner allows the name, else at the address it resolved to.
	target := host
	if len(addrs) > 0 {
		target = addrs[0]
	}
	endpoint := "opc.tcp://" + net.JoinHostPort(target, port) + path
	options := []opcua.Option{
		opcua.AutoReconnect(false), opcua.DialTimeout(10 * time.Second), opcua.RequestTimeout(15 * time.Second),
		opcua.SessionTimeout(2 * time.Minute), opcua.ApplicationName("Silo Agent"),
	}
	if len(onLost) > 0 {
		connected := false
		options = append(options, opcua.StateChangedFunc(func(state opcua.ConnState) {
			if state == opcua.Connected {
				connected = true
			}
			if connected && (state == opcua.Disconnected || state == opcua.Closed) {
				onLost[0]()
			}
		}))
	}
	// The login first: the endpoint's token policy is then set on it.
	tokenType := ua.UserTokenTypeAnonymous
	if server.Credential != nil {
		if o.logins == nil {
			e := refused(login.RefusedNoKey)
			return nil, nil, &e
		}
		l, reason := o.logins.Open(server.Credential, server.ConnectionID, protocol.WorkID(ctx), time.Now())
		if reason != "" {
			e := refused(reason)
			return nil, nil, &e
		}
		defer l.Zero()
		password := ""
		if l.Password != nil {
			password = string(l.Password.Bytes())
		}
		options = append(options, opcua.AuthUsername(l.User, password))
		tokenType = ua.UserTokenTypeUserName
	} else {
		options = append(options, opcua.AuthAnonymous())
	}
	var presented []byte
	if signed {
		if o.logins == nil {
			e := refused(login.RefusedNoKey)
			return nil, nil, &e
		}
		key, reason := o.logins.OpenKey(server.ApplicationKey, server.ConnectionID, protocol.WorkID(ctx), time.Now())
		if reason != "" {
			e := refused(reason)
			return nil, nil, &e
		}
		parsed, err := x509.ParseCertificate(certificate)
		if err != nil {
			return nil, nil, failed(protocol.Integrity)
		}
		if public, ok := parsed.PublicKey.(*rsa.PublicKey); !ok || !public.Equal(&key.PublicKey) {
			return nil, nil, failed(protocol.Integrity)
		}
		ectx, cancel := context.WithTimeout(ctx, 15*time.Second)
		endpoints, err := opcua.GetEndpoints(ectx, endpoint, opcua.DialTimeout(10*time.Second))
		cancel()
		if err != nil {
			return nil, nil, failed(protocol.SourceUnreachable)
		}
		var chosen *ua.EndpointDescription
		for _, ep := range endpoints {
			if ep.SecurityPolicyURI == policyURI && ep.SecurityMode == mode {
				chosen = ep
				break
			}
		}
		if chosen == nil {
			return nil, nil, sourceRefused(protocol.RefusedPolicy)
		}
		// The leaf certificate, checked against the owner's pin before any secret is sent.
		chain, err := x509.ParseCertificates(chosen.ServerCertificate)
		if err != nil || len(chain) == 0 || !serverPinned(chain[0].Raw, server.ServerThumbprint) {
			return nil, nil, sourceRefused(protocol.RefusedServerCertificate)
		}
		presented = chain[0].Raw
		options = append(options, opcua.Certificate(certificate), opcua.PrivateKey(key), opcua.SecurityFromEndpoint(chosen, tokenType))
	} else {
		options = append(options, opcua.SecurityPolicy("None"), opcua.SecurityMode(ua.MessageSecurityModeNone), opcua.ApplicationURI("urn:silohq.io:agent"))
	}
	client, err := opcua.NewClient(endpoint, options...)
	if err != nil {
		return nil, nil, failed(protocol.Integrity)
	}
	cctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	if err := client.Connect(cctx); err != nil {
		var code ua.StatusCode
		errors.As(err, &code)
		switch {
		// gopcua reads a server's ERR message during OpenSecureChannel as the connection's end
		// (uasc checks for an empty read before the uacp error), and servers that say nothing
		// close it: a signed channel ending as it opens, on a server that has just answered
		// GetEndpoints, is the server refusing the application certificate.
		case signed && code == 0 && (errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, syscall.ECONNRESET)):
			return nil, nil, sourceRefused(protocol.RefusedUntrusted)
		case untrustedCodes[code]:
			return nil, nil, sourceRefused(protocol.RefusedUntrusted)
		case loginCodes[code]:
			return nil, nil, sourceRefused(protocol.RefusedLogin)
		case code != 0 && code != ua.StatusOK:
			return nil, nil, failed(protocol.SourceRefused)
		}
		return nil, nil, failed(protocol.SourceUnreachable)
	}
	namespaces, err := client.NamespaceArray(ctx)
	if err != nil {
		client.Close(context.Background())
		return nil, nil, failed(protocol.SourceRefused)
	}
	return &opcuaSession{client: client, namespaces: namespaces}, presented, nil
}

const (
	maxOPCUAMonitored = 10_000
	opcuaMonitorChunk = 1_000
)

type monitoredItem struct {
	object     string
	browseName string
	nodeID     string
	path       string
}

func valueStatus(code ua.StatusCode) string {
	switch {
	case code == ua.StatusOK || uint32(code)&0xC0000000 == 0:
		return "good"
	case uint32(code)&0xC0000000 == 0x40000000:
		return "uncertain"
	default:
		return "bad"
	}
}

func dataChangeFilter(deadband *protocol.OPCUADeadband) (*ua.ExtensionObject, bool) {
	if deadband == nil {
		return nil, true
	}
	kind := ua.DeadbandTypeAbsolute
	switch deadband.Type {
	case "absolute":
	case "percent":
		kind = ua.DeadbandTypePercent
	default:
		return nil, false
	}
	return ua.NewExtensionObject(&ua.DataChangeFilter{
		Trigger: ua.DataChangeTriggerStatusValue, DeadbandType: uint32(kind), DeadbandValue: deadband.Value,
	}), true
}

// Monitor runs an opcua capture until ctx ends, the session is lost or the cell falls behind.
func (o *OPCUA) Monitor(ctx context.Context, connectionID, slotID string, sub *protocol.OPCUACapture, started func() error,
	deliver func(samples []map[string]any) error) *protocol.Error {
	if sub == nil || len(sub.Objects) == 0 {
		return failed(protocol.Integrity)
	}
	// The key and login were sealed for this capture: the slot is their work.
	ctx = protocol.WithWorkID(ctx, slotID)
	server := sub.OPCUAServer
	server.ConnectionID = connectionID
	lost := make(chan struct{})
	var lostOnce sync.Once
	sess, _, refusal := o.connect(ctx, server, func() { lostOnce.Do(func() { close(lost) }) })
	if refusal != nil {
		return refusal
	}
	defer sess.client.Close(context.Background())
	var items []monitoredItem
	var requests []*ua.MonitoredItemCreateRequest
	interval := time.Duration(0)
	for _, object := range sub.Objects {
		filter, ok := dataChangeFilter(object.Deadband)
		if !ok || object.Object == "" {
			return failed(protocol.Integrity)
		}
		for _, p := range object.Paths {
			if !validPath(p) {
				return failed(protocol.Integrity)
			}
		}
		root, ok := sess.resolve(object.Root)
		if !ok {
			return failed(protocol.SourceRefused)
		}
		var typeDef *ua.NodeID
		if object.TypeDefinition != "" {
			if typeDef, ok = sess.resolve(object.TypeDefinition); !ok {
				return failed(protocol.SourceRefused)
			}
		}
		instances, err := sess.children(ctx, root)
		if err != nil {
			return failed(protocol.SourceRefused)
		}
		sampling := time.Duration(object.SamplingMs * float64(time.Millisecond))
		if interval == 0 || (sampling > 0 && sampling < interval) {
			interval = sampling
		}
		for _, instance := range instances {
			if typeDef != nil && (instance.typeDef == nil || instance.typeDef.String() != typeDef.String()) {
				continue
			}
			for _, p := range object.Paths {
				if p == "$browseName" || p == "$nodeId" {
					continue
				}
				node, found, err := sess.walk(ctx, instance.id, p)
				if err != nil {
					return failed(protocol.SourceRefused)
				}
				if !found {
					continue
				}
				if len(items) >= maxOPCUAMonitored {
					return failed(protocol.Capacity)
				}
				request := opcua.NewMonitoredItemCreateRequestWithDefaults(node, ua.AttributeIDValue, uint32(len(items)))
				request.RequestedParameters.SamplingInterval = object.SamplingMs
				if object.QueueSize > 0 {
					request.RequestedParameters.QueueSize = object.QueueSize
				}
				if filter != nil {
					request.RequestedParameters.Filter = filter
				}
				requests = append(requests, request)
				items = append(items, monitoredItem{object: object.Object, browseName: instance.browseName, nodeID: sess.address(instance.id), path: p})
			}
		}
	}
	if len(items) == 0 {
		return failed(protocol.SourceRefused)
	}
	if interval <= 0 {
		interval = 100 * time.Millisecond
	}
	notifications := make(chan *opcua.PublishNotificationData, 64)
	subscription, err := sess.client.Subscribe(ctx, &opcua.SubscriptionParameters{Interval: interval}, notifications)
	if err != nil {
		return failed(protocol.SourceRefused)
	}
	defer subscription.Cancel(context.Background())
	accepted := 0
	for start := 0; start < len(requests); start += opcuaMonitorChunk {
		end := min(start+opcuaMonitorChunk, len(requests))
		res, err := subscription.Monitor(ctx, ua.TimestampsToReturnBoth, requests[start:end]...)
		if err != nil || len(res.Results) != end-start {
			return failed(protocol.SourceRefused)
		}
		for _, result := range res.Results {
			if result.StatusCode == ua.StatusOK {
				accepted++
			}
		}
	}
	if accepted == 0 {
		return failed(protocol.SourceRefused)
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
			return failed(protocol.SourceUnreachable)
		case note := <-notifications:
			if note.Error != nil {
				return failed(protocol.SourceUnreachable)
			}
			change, ok := note.Value.(*ua.DataChangeNotification)
			if !ok {
				continue
			}
			for _, n := range change.MonitoredItems {
				if n == nil || n.Value == nil || int(n.ClientHandle) >= len(items) {
					continue
				}
				item := items[n.ClientHandle]
				row := map[string]any{
					"object": item.object, "browseName": item.browseName, "nodeId": item.nodeID, "path": item.path,
					"value": jsonValue(n.Value.Value), "status": valueStatus(n.Value.Status),
				}
				if !n.Value.SourceTimestamp.IsZero() {
					row["sourceAt"] = n.Value.SourceTimestamp.UTC().Format(time.RFC3339Nano)
				}
				if !n.Value.ServerTimestamp.IsZero() {
					row["serverAt"] = n.Value.ServerTimestamp.UTC().Format(time.RFC3339Nano)
				}
				batch = append(batch, row)
				if len(batch) >= subscribeBatch && !send() {
					return nil
				}
			}
		case <-flush.C:
			if !send() {
				return nil
			}
			flush.Reset(subscribeFlush)
		}
	}
}

// walk resolves a browse path under a node by browsing each level.
func (s *opcuaSession) walk(ctx context.Context, from *ua.NodeID, path string) (*ua.NodeID, bool, error) {
	node := from
	for _, segment := range strings.Split(path, "/") {
		kids, err := s.children(ctx, node)
		if err != nil {
			return nil, false, err
		}
		var next *ua.NodeID
		for _, k := range kids {
			if k.browseName == segment {
				next = k.id
				break
			}
		}
		if next == nil {
			return nil, false, nil
		}
		node = next
	}
	return node, true, nil
}
