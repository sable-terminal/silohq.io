// Package opcuatest is a small OPC UA server for the agent's tests (spec 20.3): a plant whose
// Pumps folder holds two pumps, each with a temperature, a mode and a motor with its speed,
// in a namespace named by URI, with anonymous logins. Each speed has a simulator counterpart
// (Sim.PumpN.Motor.Speed) for dry runs (47.5), addressable by node only.
//
// Start serves under security policy None only, what the agent reads under a recorded
// exception. StartSecure also offers Basic256Sha256 with Sign and SignAndEncrypt, under a
// certificate of its own, and trusts only the application certificates in a directory, read at
// each connection as a server's trust list is: an OpenSecureChannel from any other certificate
// is answered Bad_SecurityChecksFailed and closed, as servers do (gopcua's server keeps no trust
// list, so a relay in front of it checks the request's sender certificate, which travels in the
// clear).
package opcuatest

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gopcua/opcua/id"
	"github.com/gopcua/opcua/server"
	"github.com/gopcua/opcua/server/attrs"
	"github.com/gopcua/opcua/ua"
	"github.com/gopcua/opcua/uasc"
)

// NamespaceURI is the plant's namespace, as the manifest names it.
const NamespaceURI = "urn:silo:test:plant"

// Plant is a running test server.
type Plant struct {
	srv *server.Server
	// Speeds are each pump's motor speed, changed by the test.
	Speeds map[string]int32
	// Certificate is the server's certificate, DER (StartSecure only).
	Certificate []byte

	trustDir string
	internal string
	listener net.Listener
	wg       sync.WaitGroup
	mu       sync.Mutex
	ns       *server.NodeNameSpace
	running  map[string]bool
	modes    map[string]string
}

// Mode is the mode a pump's motor was last ramped in.
func (p *Plant) Mode(pump string) string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.modes[pump]
}

// Running is whether a pump's motor runs: what its Start and Stop methods change.
func (p *Plant) Running(pump string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.running[pump]
}

// call answers a CallRequest as the plant's control system: a motor's Start and Stop; Jog is
// always refused (BadInvalidState), as a control system refuses a command it will not take.
func (p *Plant) call(_ *uasc.SecureChannel, r ua.Request, _ uint32) (ua.Response, error) {
	req, ok := r.(*ua.CallRequest)
	if !ok {
		return nil, ua.StatusBadRequestTypeInvalid
	}
	results := make([]*ua.CallMethodResult, len(req.MethodsToCall))
	for i, m := range req.MethodsToCall {
		status := ua.StatusBadMethodInvalid
		key := m.MethodID.StringID()
		if int(m.MethodID.Namespace()) == int(p.ns.ID()) {
			p.mu.Lock()
			switch {
			case strings.HasSuffix(key, ".Motor.Start"):
				p.running[strings.TrimSuffix(key, ".Motor.Start")] = true
				status = ua.StatusOK
			case strings.HasSuffix(key, ".Motor.Stop"):
				p.running[strings.TrimSuffix(key, ".Motor.Stop")] = false
				status = ua.StatusOK
			case strings.HasSuffix(key, ".Motor.Jog"):
				status = ua.StatusBadInvalidState
			case strings.HasSuffix(key, ".Motor.Ramp"):
				// Ramp(Rpm Int32, Mode String): the speed and the mode it runs at.
				status = ua.StatusBadArgumentsMissing
				if len(m.InputArguments) == 2 {
					rpm, okRpm := m.InputArguments[0].Value().(int32)
					mode, okMode := m.InputArguments[1].Value().(string)
					status = ua.StatusBadTypeMismatch
					if okRpm && okMode {
						pump := strings.TrimSuffix(key, ".Motor.Ramp")
						p.Speeds[pump], p.modes[pump] = rpm, mode
						status = ua.StatusOK
					}
				}
			}
			p.mu.Unlock()
		}
		results[i] = &ua.CallMethodResult{StatusCode: status, InputArgumentResults: []ua.StatusCode{}, InputArgumentDiagnosticInfos: []*ua.DiagnosticInfo{}, OutputArguments: []*ua.Variant{}}
	}
	return &ua.CallResponse{
		ResponseHeader: &ua.ResponseHeader{
			Timestamp: time.Now(), RequestHandle: req.RequestHeader.RequestHandle, ServiceResult: ua.StatusOK,
			ServiceDiagnostics: &ua.DiagnosticInfo{}, StringTable: []string{}, AdditionalHeader: ua.NewExtensionObject(nil),
		},
		Results: results, DiagnosticInfos: []*ua.DiagnosticInfo{},
	}, nil
}

func method(ns *server.NodeNameSpace, key, name string) *server.Node {
	return ns.AddNode(server.NewNode(ua.NewStringNodeID(ns.ID(), key), map[ua.AttributeID]*ua.DataValue{
		ua.AttributeIDNodeClass:      server.DataValueFromValue(uint32(ua.NodeClassMethod)),
		ua.AttributeIDBrowseName:     server.DataValueFromValue(attrs.BrowseName(name)),
		ua.AttributeIDDisplayName:    server.DataValueFromValue(attrs.DisplayName(name, name)),
		ua.AttributeIDExecutable:     server.DataValueFromValue(true),
		ua.AttributeIDUserExecutable: server.DataValueFromValue(true),
	}, nil, nil))
}

// inputArguments gives a method its InputArguments property: each argument's name and built-in type, scalar.
func inputArguments(ns *server.NodeNameSpace, m *server.Node, key string, args ...ua.Argument) {
	objects := make([]*ua.ExtensionObject, 0, len(args))
	for i := range args {
		a := args[i]
		a.ValueRank, a.ArrayDimensions, a.Description = -1, []uint32{}, &ua.LocalizedText{}
		objects = append(objects, ua.NewExtensionObject(&a))
	}
	property := ns.AddNode(server.NewNode(ua.NewStringNodeID(ns.ID(), key+".InputArguments"), map[ua.AttributeID]*ua.DataValue{
		ua.AttributeIDNodeClass:       server.DataValueFromValue(uint32(ua.NodeClassVariable)),
		ua.AttributeIDDataType:        server.DataValueFromValue(ua.NewNumericNodeID(0, id.Argument)),
		ua.AttributeIDBrowseName:      server.DataValueFromValue(attrs.BrowseName("InputArguments")),
		ua.AttributeIDDisplayName:     server.DataValueFromValue(attrs.DisplayName("InputArguments", "InputArguments")),
		ua.AttributeIDAccessLevel:     server.DataValueFromValue(byte(ua.AccessLevelTypeCurrentRead)),
		ua.AttributeIDUserAccessLevel: server.DataValueFromValue(byte(ua.AccessLevelTypeCurrentRead)),
	}, nil, func() *ua.DataValue { return stamped(objects) }))
	m.AddRef(property, id.HasProperty, true)
}

// SetSpeed changes a pump's motor speed and tells the server, so monitored items see it.
func (p *Plant) SetSpeed(pump string, rpm int32) {
	p.mu.Lock()
	p.Speeds[pump] = rpm
	p.mu.Unlock()
	p.srv.ChangeNotification(ua.NewStringNodeID(p.ns.ID(), pump+".Motor.Speed"))
}

// Speed is a pump's motor speed now.
func (p *Plant) Speed(pump string) int32 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.Speeds[pump]
}

// Close stops the server.
func (p *Plant) Close() error {
	if p.listener != nil {
		p.listener.Close()
		p.wg.Wait()
	}
	return p.srv.Close()
}

func object(ns *server.NodeNameSpace, key, name string) *server.Node {
	return ns.AddNode(server.NewNode(ua.NewStringNodeID(ns.ID(), key), map[ua.AttributeID]*ua.DataValue{
		ua.AttributeIDNodeClass:   server.DataValueFromValue(uint32(ua.NodeClassObject)),
		ua.AttributeIDBrowseName:  server.DataValueFromValue(attrs.BrowseName(name)),
		ua.AttributeIDDisplayName: server.DataValueFromValue(attrs.DisplayName(name, name)),
	}, nil, nil))
}

// dataTypeOf is a value's OPC UA data type, as a variable's DataType attribute names it.
func dataTypeOf(value any) *ua.NodeID {
	switch value.(type) {
	case int32:
		return ua.NewNumericNodeID(0, id.Int32)
	case float64:
		return ua.NewNumericNodeID(0, id.Double)
	case string:
		return ua.NewNumericNodeID(0, id.String)
	default:
		return ua.NewNumericNodeID(0, id.BaseDataType)
	}
}

// The plant's own limits on a motor's speed: above ClampSpeed it runs at ClampSpeed (the
// server says GoodClamped); above MaxSpeed it refuses (BadOutOfRange).
const (
	ClampSpeed = 2000
	MaxSpeed   = 3000
)

// write answers a WriteRequest as the plant's control system: a motor's speed only.
func (p *Plant) write(_ *uasc.SecureChannel, r ua.Request, _ uint32) (ua.Response, error) {
	req, ok := r.(*ua.WriteRequest)
	if !ok {
		return nil, ua.StatusBadRequestTypeInvalid
	}
	status := make([]ua.StatusCode, len(req.NodesToWrite))
	for i, w := range req.NodesToWrite {
		status[i] = ua.StatusBadNotWritable
		pump, isSpeed := strings.CutSuffix(w.NodeID.StringID(), ".Motor.Speed")
		if !isSpeed || int(w.NodeID.Namespace()) != int(p.ns.ID()) || w.AttributeID != ua.AttributeIDValue || w.Value == nil || w.Value.Value == nil {
			continue
		}
		rpm, ok := w.Value.Value.Value().(int32)
		switch {
		case !ok:
			status[i] = ua.StatusBadTypeMismatch
		case rpm < 0 || rpm > MaxSpeed:
			status[i] = ua.StatusBadOutOfRange
		case rpm > ClampSpeed:
			status[i] = ua.StatusGoodClamped
			p.SetSpeed(pump, ClampSpeed)
		default:
			status[i] = ua.StatusOK
			p.SetSpeed(pump, rpm)
		}
	}
	return &ua.WriteResponse{
		ResponseHeader: &ua.ResponseHeader{
			Timestamp: time.Now(), RequestHandle: req.RequestHeader.RequestHandle, ServiceResult: ua.StatusOK,
			ServiceDiagnostics: &ua.DiagnosticInfo{}, StringTable: []string{}, AdditionalHeader: ua.NewExtensionObject(nil),
		},
		Results: status, DiagnosticInfos: []*ua.DiagnosticInfo{},
	}, nil
}

func variable(ns *server.NodeNameSpace, key, name string, value func() any) *server.Node {
	return variableWith(ns, key, name, value, ua.AccessLevelTypeCurrentRead)
}

func variableWith(ns *server.NodeNameSpace, key, name string, value func() any, access ua.AccessLevelType) *server.Node {
	return ns.AddNode(server.NewNode(ua.NewStringNodeID(ns.ID(), key), map[ua.AttributeID]*ua.DataValue{
		ua.AttributeIDNodeClass:       server.DataValueFromValue(uint32(ua.NodeClassVariable)),
		ua.AttributeIDDataType:        server.DataValueFromValue(dataTypeOf(value())),
		ua.AttributeIDBrowseName:      server.DataValueFromValue(attrs.BrowseName(name)),
		ua.AttributeIDDisplayName:     server.DataValueFromValue(attrs.DisplayName(name, name)),
		ua.AttributeIDAccessLevel:     server.DataValueFromValue(byte(access)),
		ua.AttributeIDUserAccessLevel: server.DataValueFromValue(byte(access)),
	}, nil, func() *ua.DataValue { return stamped(value()) }))
}

// stamped is a value as a server reports it: with the source's and the server's timestamps.
func stamped(value any) *ua.DataValue {
	dv := server.DataValueFromValue(value)
	now := time.Now()
	dv.SourceTimestamp, dv.ServerTimestamp = now, now
	dv.EncodingMask |= ua.DataValueSourceTimestamp | ua.DataValueServerTimestamp
	return dv
}

// Start runs the plant on 127.0.0.1:port under security policy None.
func Start(ctx context.Context, port int) (*Plant, error) {
	srv := server.New(
		server.EnableSecurity("None", ua.MessageSecurityModeNone),
		server.EnableAuthMode(ua.UserTokenTypeAnonymous),
		server.EndPoint("127.0.0.1", port),
		server.EndPoint("localhost", port),
	)
	return serve(ctx, &Plant{srv: srv})
}

// StartSecure runs the plant on 127.0.0.1:port offering None and Basic256Sha256 (Sign,
// SignAndEncrypt), trusting the application certificates in trustDir (PEM or DER files).
func StartSecure(ctx context.Context, port int, trustDir string) (*Plant, error) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, err
	}
	uri, _ := url.Parse("urn:silo:test:plant:server")
	serial, _ := rand.Int(rand.Reader, big.NewInt(1<<62))
	template := &x509.Certificate{
		SerialNumber: serial, Subject: pkix.Name{CommonName: "Silo test plant"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature | x509.KeyUsageContentCommitment | x509.KeyUsageKeyEncipherment |
			x509.KeyUsageDataEncipherment | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		BasicConstraintsValid: true, URIs: []*url.URL{uri}, DNSNames: []string{"localhost"}, IPAddresses: []net.IP{net.IPv4(127, 0, 0, 1)},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return nil, err
	}
	// The server listens on a port of its own; the relay in front of it takes the plant's port.
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	internal := probe.Addr().(*net.TCPAddr).Port
	probe.Close()
	srv := server.New(
		server.EnableSecurity("None", ua.MessageSecurityModeNone),
		server.EnableSecurity("Basic256Sha256", ua.MessageSecurityModeSign),
		server.EnableSecurity("Basic256Sha256", ua.MessageSecurityModeSignAndEncrypt),
		server.EnableAuthMode(ua.UserTokenTypeAnonymous),
		// It listens on the first endpoint and answers GetEndpoints for each it names: the relay's too.
		server.EndPoint("127.0.0.1", internal),
		server.EndPoint("127.0.0.1", port),
		server.EndPoint("localhost", port),
		server.Certificate(der),
		server.PrivateKey(key),
	)
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return nil, err
	}
	plant := &Plant{srv: srv, Certificate: der, trustDir: trustDir, internal: fmt.Sprintf("127.0.0.1:%d", internal), listener: listener}
	if _, err := serve(ctx, plant); err != nil {
		listener.Close()
		return nil, err
	}
	plant.wg.Add(1)
	go func() {
		defer plant.wg.Done()
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go plant.relay(conn)
		}
	}()
	return plant, nil
}

func serve(ctx context.Context, plant *Plant) (*Plant, error) {
	srv := plant.srv
	// Registered before Start, so the server's own write handler (which takes anything) is not.
	srv.RegisterHandler(id.WriteRequest_Encoding_DefaultBinary, plant.write)
	srv.RegisterHandler(id.CallRequest_Encoding_DefaultBinary, plant.call)
	if err := srv.Start(ctx); err != nil {
		return nil, fmt.Errorf("the test plant did not start: %w", err)
	}
	plant.Speeds = map[string]int32{"Pump1": 1450, "Pump2": 0, "Sim.Pump1": 1450, "Sim.Pump2": 0}
	plant.running = map[string]bool{"Pump1": true, "Pump2": false}
	plant.modes = map[string]string{}
	ns := server.NewNodeNameSpace(srv, NamespaceURI)
	plant.ns = ns
	root, _ := srv.Namespace(0)
	objects := root.Objects()
	pumps := object(ns, "Pumps", "Pumps")
	objects.AddRef(pumps, id.Organizes, true)
	for i, name := range []string{"Pump1", "Pump2"} {
		pump := object(ns, name, name)
		pumps.AddRef(pump, id.Organizes, true)
		temperature := 61.5 + float64(i)*10
		mode := []string{"auto", "manual"}[i]
		pump.AddRef(variable(ns, name+".Temperature", "Temperature", func() any { return temperature }), id.HasComponent, true)
		pump.AddRef(variable(ns, name+".Mode", "Mode", func() any { return mode }), id.HasComponent, true)
		motor := object(ns, name+".Motor", "Motor")
		pump.AddRef(motor, id.HasComponent, true)
		key := name
		motor.AddRef(variableWith(ns, name+".Motor.Speed", "Speed", func() any { return plant.Speed(key) },
			ua.AccessLevelTypeCurrentRead|ua.AccessLevelTypeCurrentWrite), id.HasComponent, true)
		// The simulator's counterpart (47.5): addressable by node, outside the browsed tree, so discovery does not see it.
		sim := "Sim." + name
		variableWith(ns, sim+".Motor.Speed", "Speed", func() any { return plant.Speed(sim) }, ua.AccessLevelTypeCurrentRead|ua.AccessLevelTypeCurrentWrite)
		// Commands (47.1): the motor's methods, and the simulator's counterparts.
		for _, m := range []string{"Start", "Stop", "Jog"} {
			motor.AddRef(method(ns, name+".Motor."+m, m), id.HasComponent, true)
			method(ns, sim+".Motor."+m, m)
		}
		// Ramp takes input arguments (D245): the speed and the mode, in that order.
		for _, at := range []string{name, sim} {
			ramp := method(ns, at+".Motor.Ramp", "Ramp")
			if at == name {
				motor.AddRef(ramp, id.HasComponent, true)
			}
			inputArguments(ns, ramp, at+".Motor.Ramp",
				ua.Argument{Name: "Rpm", DataType: ua.NewNumericNodeID(0, id.Int32)}, ua.Argument{Name: "Mode", DataType: ua.NewNumericNodeID(0, id.String)})
		}
	}
	return plant, nil
}

// relay passes one connection to the server, checking its first OpenSecureChannel's sender
// certificate against the trust list.
func (p *Plant) relay(client net.Conn) {
	defer client.Close()
	upstream, err := net.Dial("tcp", p.internal)
	if err != nil {
		return
	}
	defer upstream.Close()
	go func() {
		io.Copy(client, upstream)
		client.Close()
	}()
	for {
		header := make([]byte, 8)
		if _, err := io.ReadFull(client, header); err != nil {
			return
		}
		size := binary.LittleEndian.Uint32(header[4:])
		if size < 8 || size > 1<<20 {
			return
		}
		body := make([]byte, size-8)
		if _, err := io.ReadFull(client, body); err != nil {
			return
		}
		opn := string(header[:3]) == "OPN"
		if opn && !p.admits(body) {
			refuse(client, ua.StatusBadSecurityChecksFailed)
			return
		}
		if _, err := upstream.Write(append(header, body...)); err != nil {
			return
		}
		if opn {
			break
		}
	}
	io.Copy(upstream, client)
}

// byteString reads an OPC UA ByteString: a little-endian int32 length (-1 for null), then the bytes.
func byteString(b []byte) ([]byte, []byte, bool) {
	if len(b) < 4 {
		return nil, nil, false
	}
	n := int32(binary.LittleEndian.Uint32(b))
	b = b[4:]
	if n < 0 {
		return nil, b, true
	}
	if int(n) > len(b) {
		return nil, nil, false
	}
	return b[:n], b[n:], true
}

// admits is whether an OpenSecureChannel may go on: None, or a sender certificate the plant trusts.
func (p *Plant) admits(body []byte) bool {
	if len(body) < 4 {
		return false
	}
	policy, rest, ok := byteString(body[4:])
	if !ok {
		return false
	}
	if string(policy) == ua.SecurityPolicyURINone {
		return true
	}
	sender, _, ok := byteString(rest)
	if !ok {
		return false
	}
	chain, err := x509.ParseCertificates(sender)
	if err != nil || len(chain) == 0 {
		return false
	}
	return p.trusted(chain[0].Raw)
}

func (p *Plant) trusted(leaf []byte) bool {
	entries, _ := os.ReadDir(p.trustDir)
	for _, entry := range entries {
		data, err := os.ReadFile(filepath.Join(p.trustDir, entry.Name()))
		if err != nil {
			continue
		}
		if block, _ := pem.Decode(data); block != nil {
			data = block.Bytes
		}
		if bytes.Equal(data, leaf) {
			return true
		}
	}
	return false
}

// refuse answers with an ERR message, as a server refusing a channel does.
func refuse(conn net.Conn, code ua.StatusCode) {
	reason := []byte("the application certificate is not trusted")
	msg := make([]byte, 16+len(reason))
	copy(msg, "ERRF")
	binary.LittleEndian.PutUint32(msg[4:], uint32(len(msg)))
	binary.LittleEndian.PutUint32(msg[8:], uint32(code))
	binary.LittleEndian.PutUint32(msg[12:], uint32(len(reason)))
	copy(msg[16:], reason)
	conn.Write(msg)
}
