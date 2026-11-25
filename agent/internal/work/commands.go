package work

// Commands (spec 47.1, 47.4 to 47.6): opcua.call calls an OPC UA method and mqtt.publish
// publishes an MQTT command, as a physical Action's execution, and only on the grant actions
// signed for exactly these statements. A command has no persistent state: it is verified by
// acknowledgement (the method's status, the broker's PUBACK), which does not confirm the
// physical outcome. Before anything is sent, every command must be in this agent's current
// signed allow-list for the connection (an OPC UA method, an MQTT command topic), its last call at
// least the entry's interval ago, and the plan within the connection's writes a minute; one
// refusal and nothing at all is sent. A method's input arguments (D245) must be the ones its
// entry names, and the ones the method itself declares (its InputArguments), name for name and
// type for type, each value of that type and within the entry's bounds (arguments, data_type,
// range); each is sent as that type. A dry run (47.5) sends to the simulator counterpart the
// signed entry names, never production, and counts against neither. A status that is not good
// is the control system's rejection, the outcome, never retried.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/gopcua/opcua/id"
	"github.com/gopcua/opcua/ua"

	"silohq.io/agent/internal/actuation"
	"silohq.io/agent/internal/grant"
	"silohq.io/agent/internal/protocol"
)

type opcuaCall struct {
	protocol.OPCUAServer
	Root           string          `json:"root"`
	TypeDefinition string          `json:"typeDefinition,omitempty"`
	Statements     json.RawMessage `json:"statements"`
	Grant          *grant.Signed   `json:"grant"`
}

type callStatement struct {
	Key      string `json:"key"`
	Instance string `json:"instance"`
	// Method is the method's browse path under the instance ("Motor/Start"); it is called on its parent.
	Method       string `json:"method"`
	Inputs       []any  `json:"inputs"`
	MaxPerMinute int    `json:"maxPerMinute"`
	DryRun       bool   `json:"dryRun,omitempty"`
}

type plannedCall struct {
	key, path, address, simulator string
	object, method                *ua.NodeID
	entry                         actuation.Entry
	inputs                        []any
	arguments                     []*ua.Variant
	refusal, status               string
	dryRun                        bool
}

// errArguments is a method declaring its input arguments in a form not read here.
var errArguments = errors.New("the method's input arguments do not read")

// inputArguments are a method's declared input arguments (its InputArguments property), or none.
func (s *opcuaSession) inputArguments(ctx context.Context, method *ua.NodeID) ([]*ua.Argument, error) {
	refs, err := s.client.Node(method).References(ctx, id.HasProperty, ua.BrowseDirectionForward, ua.NodeClassVariable, true)
	if err != nil {
		return nil, err
	}
	for _, ref := range refs {
		if ref.NodeID == nil || ref.BrowseName == nil || ref.BrowseName.Name != "InputArguments" {
			continue
		}
		v, err := s.client.Node(ref.NodeID.NodeID).Value(ctx)
		if err != nil {
			return nil, err
		}
		if v == nil || v.Value() == nil {
			return nil, nil
		}
		objects, ok := v.Value().([]*ua.ExtensionObject)
		if !ok {
			return nil, errArguments
		}
		out := make([]*ua.Argument, 0, len(objects))
		for _, o := range objects {
			a, ok := o.Value.(*ua.Argument)
			if !ok || a == nil {
				return nil, errArguments
			}
			out = append(out, a)
		}
		return out, nil
	}
	return nil, nil
}

// methodInputs are a call's input arguments as the method takes them (D245): the signed entry's,
// name for name and type for type with the method's own declaration (scalars), each value of that
// type and within the entry's bounds. It says why not: arguments, data_type or range.
func methodInputs(listed []actuation.Argument, declared []*ua.Argument, values []any) ([]*ua.Variant, string) {
	if len(listed) != len(declared) || len(values) != len(listed) {
		return nil, "arguments"
	}
	out := make([]*ua.Variant, 0, len(values))
	for i, a := range listed {
		d, t := declared[i], actuation.ArgumentTypes[a.DataType]
		if d.Name != a.Name || d.DataType == nil || d.DataType.Namespace() != 0 || d.DataType.IntID() != t || d.ValueRank != -1 {
			return nil, "arguments"
		}
		v, ok := asType(values[i], t)
		if !ok {
			return nil, "data_type"
		}
		switch t {
		case 1:
		case 12:
			found := false
			for _, allowed := range a.Values {
				found = found || allowed == v.(string)
			}
			if !found {
				return nil, "range"
			}
		default:
			r, okR := rat(values[i])
			lo, okLo := actuation.Decimal(a.MinValue)
			hi, okHi := actuation.Decimal(a.MaxValue)
			if !okR || !okLo || !okHi || lo == nil || hi == nil || r.Cmp(lo) < 0 || r.Cmp(hi) > 0 {
				return nil, "range"
			}
		}
		variant, err := ua.NewVariant(v)
		if err != nil {
			return nil, "data_type"
		}
		out = append(out, variant)
	}
	return out, ""
}

// commandRows are the statements' outcomes: refused (why), not attempted, applied (acknowledged) or rejected.
func commandRows(planned []*plannedCall, refused bool) []map[string]any {
	rows := make([]map[string]any, 0, len(planned))
	for _, p := range planned {
		outcome := "applied"
		switch {
		case p.refusal != "":
			outcome = "refused"
		case refused:
			outcome = "not_attempted"
		case p.status == "bad":
			outcome = "rejected"
		case p.status == "unknown":
			outcome = "unknown"
		}
		node := map[string]any{"path": p.path, "nodeAddress": p.address, "entryId": p.entry.ID, "status": p.status}
		if p.dryRun && p.simulator != "" {
			node["simulatorAddress"] = p.simulator
		}
		row := map[string]any{"key": p.key, "outcome": outcome, "nodes": []map[string]any{node}}
		if p.refusal != "" {
			row["reason"] = p.refusal
		}
		rows = append(rows, row)
	}
	return rows
}

// commandAllowed says why a listed command may not be sent now (kind, interval), or "".
func commandAllowed(log *writeLog, connectionID, address string, entry actuation.Entry, kinds []string, dryRun bool, at time.Time) string {
	ok := false
	for _, k := range kinds {
		ok = ok || entry.Kind == k
	}
	if !ok {
		return "kind"
	}
	if last, wrote := log.lastWrite(connectionID, address); !dryRun && wrote && at.Sub(last) < time.Duration(entry.MinIntervalSeconds)*time.Second {
		return "interval"
	}
	return ""
}

// methodNode is the method at a browse path under a node: objects to its parent, a method last.
func (s *opcuaSession) methodNode(ctx context.Context, from *ua.NodeID, path string) (object, method *ua.NodeID, err error) {
	segments := strings.Split(path, "/")
	object = from
	if len(segments) > 1 {
		parent, found, err := s.walk(ctx, from, strings.Join(segments[:len(segments)-1], "/"))
		if err != nil || !found {
			return nil, nil, err
		}
		object = parent
	}
	refs, err := s.client.Node(object).References(ctx, id.HierarchicalReferences, ua.BrowseDirectionForward, ua.NodeClassMethod, true)
	if err != nil {
		return nil, nil, err
	}
	for _, ref := range refs {
		if ref.NodeID != nil && ref.BrowseName != nil && ref.BrowseName.Name == segments[len(segments)-1] {
			return object, ref.NodeID.NodeID, nil
		}
	}
	return nil, nil, nil
}

// Call runs an opcua.call and emits a row per statement, then done; or one error frame.
func (o *OPCUA) Call(ctx context.Context, payload json.RawMessage, emit Emit) error {
	var work opcuaCall
	if err := json.Unmarshal(payload, &work); err != nil {
		return emit(protocol.NewError(protocol.Integrity, ""))
	}
	var statements []callStatement
	decoder := json.NewDecoder(bytes.NewReader(work.Statements))
	decoder.UseNumber()
	if err := decoder.Decode(&statements); err != nil || len(statements) == 0 || len(statements) > maxPhysicalStatements {
		return emit(protocol.NewError(protocol.Integrity, ""))
	}
	if o.Grants == nil {
		return emit(protocol.Error{Type: "error", Category: protocol.GrantRefused, Reason: "unsigned"})
	}
	if _, reason := o.Grants.Check(work.Grant, work.ConnectionID, work.Statements, len(statements)); reason != "" {
		return emit(protocol.Error{Type: "error", Category: protocol.GrantRefused, Reason: reason})
	}
	sess, _, refusal := o.connect(ctx, work.OPCUAServer)
	if refusal != nil {
		return emit(*refusal)
	}
	defer sess.client.Close(context.Background())
	root, ok := sess.resolve(work.Root)
	if !ok {
		return emit(protocol.NewError(protocol.SourceRefused, ""))
	}
	instances, err := sess.children(ctx, root)
	if err != nil {
		return emit(protocol.NewError(protocol.SourceRefused, ""))
	}
	byName := map[string]*ua.NodeID{}
	for _, i := range instances {
		byName[i.browseName] = i.id
	}
	now := time.Now()
	planned := make([]*plannedCall, 0, len(statements))
	counted := 0
	for _, s := range statements {
		p := &plannedCall{key: s.Key, path: s.Method, inputs: s.Inputs, dryRun: s.DryRun}
		planned = append(planned, p)
		instance, found := byName[s.Instance]
		if !found || !validPath(s.Method) || strings.HasPrefix(s.Method, "$") {
			p.refusal = "instance"
			continue
		}
		object, method, err := sess.methodNode(ctx, instance, s.Method)
		if err != nil {
			return emit(protocol.NewError(protocol.SourceRefused, ""))
		}
		if method == nil {
			p.refusal = "node"
			continue
		}
		p.object, p.method, p.address = object, method, sess.address(method)
		entry, listed := actuation.Entry{}, false
		if o.Allowlists != nil {
			entry, listed = o.Allowlists.Lookup(work.ConnectionID, "opcua", p.address)
		}
		p.entry = entry
		if !listed {
			p.refusal = "not_listed"
			continue
		}
		if reason := commandAllowed(o.writes, work.ConnectionID, p.address, entry, []string{"method"}, s.DryRun, now); reason != "" {
			p.refusal = reason
			continue
		}
		if s.DryRun {
			var sim *ua.NodeID
			if entry.SimulatorAddress != nil {
				sim, _ = sess.resolve(*entry.SimulatorAddress)
			}
			if sim == nil {
				p.refusal = "no_simulator"
				continue
			}
			p.method, p.simulator = sim, *entry.SimulatorAddress
		} else {
			counted++
		}
		// The method called (production's, or the simulator's) declares the arguments it takes.
		declared, err := sess.inputArguments(ctx, p.method)
		if errors.Is(err, errArguments) {
			p.refusal = "arguments"
			continue
		}
		if err != nil {
			return emit(protocol.NewError(protocol.SourceRefused, ""))
		}
		args, reason := methodInputs(entry.Arguments, declared, s.Inputs)
		if reason != "" {
			p.refusal = reason
			continue
		}
		p.arguments = args
	}
	if perMinute := statements[0].MaxPerMinute; perMinute > 0 && o.writes.inLastMinute(work.ConnectionID, now)+counted > perMinute {
		for _, p := range planned {
			if p.refusal == "" {
				p.refusal = "rate"
			}
		}
	}
	refused := false
	for _, p := range planned {
		refused = refused || p.refusal != ""
	}
	if !refused {
		for _, p := range planned {
			res, err := sess.client.Call(ctx, &ua.CallMethodRequest{ObjectID: p.object, MethodID: p.method, InputArguments: p.arguments})
			switch {
			case err != nil || res == nil:
				p.status = "unknown"
			case res.StatusCode == ua.StatusOK || uint32(res.StatusCode)&0xC0000000 == 0:
				p.status = "good"
				if !p.dryRun {
					o.writes.wrote(work.ConnectionID, p.address, time.Now())
				}
			default:
				p.status = "bad"
			}
		}
	}
	if err := emit(protocol.NewRows(commandRows(planned, refused))); err != nil {
		return err
	}
	return emit(protocol.NewDone(len(planned), false))
}

type mqttPublish struct {
	ConnectionID string                `json:"connectionId"`
	EndpointURL  string                `json:"endpointUrl"`
	Statements   json.RawMessage       `json:"statements"`
	Grant        *grant.Signed         `json:"grant"`
	Credential   *protocol.SealedLogin `json:"credential"`
}

type publishStatement struct {
	Key     string `json:"key"`
	Topic   string `json:"topic"`
	Payload string `json:"payload"`
	QoS     byte   `json:"qos"`
	// Retained only where the manifest flags the topic so (20.2): a retained command persists on the broker.
	Retained     bool `json:"retained"`
	MaxPerMinute int  `json:"maxPerMinute"`
	DryRun       bool `json:"dryRun,omitempty"`
}

// Publish runs an mqtt.publish and emits a row per statement, then done; or one error frame.
func (m *MQTT) Publish(ctx context.Context, payload json.RawMessage, emit Emit) error {
	var work mqttPublish
	if err := json.Unmarshal(payload, &work); err != nil {
		return emit(protocol.NewError(protocol.Integrity, ""))
	}
	var statements []publishStatement
	if err := json.Unmarshal(work.Statements, &statements); err != nil || len(statements) == 0 || len(statements) > maxPhysicalStatements {
		return emit(protocol.NewError(protocol.Integrity, ""))
	}
	for _, s := range statements {
		if s.QoS > 2 || s.Topic == "" || strings.ContainsAny(s.Topic, "+#") || strings.HasPrefix(s.Topic, "$") || !validFilter(s.Topic) || len(s.Payload) > 256*1024 {
			return emit(protocol.NewError(protocol.Integrity, ""))
		}
	}
	if m.Grants == nil {
		return emit(protocol.Error{Type: "error", Category: protocol.GrantRefused, Reason: "unsigned"})
	}
	if _, reason := m.Grants.Check(work.Grant, work.ConnectionID, work.Statements, len(statements)); reason != "" {
		return emit(protocol.Error{Type: "error", Category: protocol.GrantRefused, Reason: reason})
	}
	now := time.Now()
	planned := make([]*plannedCall, 0, len(statements))
	topics := make([]string, 0, len(statements))
	counted := 0
	for _, s := range statements {
		p := &plannedCall{key: s.Key, path: s.Topic, address: s.Topic, dryRun: s.DryRun}
		planned = append(planned, p)
		entry, listed := actuation.Entry{}, false
		if m.Allowlists != nil {
			entry, listed = m.Allowlists.Lookup(work.ConnectionID, "mqtt", s.Topic)
		}
		p.entry = entry
		if !listed {
			p.refusal = "not_listed"
			continue
		}
		if reason := commandAllowed(m.writes, work.ConnectionID, s.Topic, entry, []string{"command"}, s.DryRun, now); reason != "" {
			p.refusal = reason
			continue
		}
		topic := s.Topic
		if s.DryRun {
			if entry.SimulatorAddress == nil || strings.ContainsAny(*entry.SimulatorAddress, "+#") {
				p.refusal = "no_simulator"
				continue
			}
			topic, p.simulator = *entry.SimulatorAddress, *entry.SimulatorAddress
		} else {
			counted++
		}
		topics = append(topics, topic)
	}
	if perMinute := statements[0].MaxPerMinute; perMinute > 0 && m.writes.inLastMinute(work.ConnectionID, now)+counted > perMinute {
		for _, p := range planned {
			if p.refusal == "" {
				p.refusal = "rate"
			}
		}
	}
	refused := false
	for _, p := range planned {
		refused = refused || p.refusal != ""
	}
	if !refused {
		filters := make([]protocol.MQTTTopic, 0, len(topics))
		for _, t := range topics {
			filters = append(filters, protocol.MQTTTopic{Filter: t})
		}
		sess, refusal := m.connect(ctx, work.EndpointURL, filters, work.Credential, work.ConnectionID, protocol.WorkID(ctx),
			"silo-p"+strings.ReplaceAll(protocol.WorkID(ctx), "-", ""), nil)
		if refusal != nil {
			return emit(*refusal)
		}
		defer sess.close()
		for i, p := range planned {
			s := statements[i]
			topic := s.Topic
			if p.dryRun {
				topic = p.simulator
			}
			token := sess.client.Publish(topic, s.QoS, s.Retained, s.Payload)
			switch {
			case !token.WaitTimeout(10 * time.Second):
				// No acknowledgement: it may have been delivered; never a retry.
				p.status = "unknown"
			case token.Error() != nil:
				p.status = "bad"
			default:
				p.status = "good"
				if !p.dryRun {
					m.writes.wrote(work.ConnectionID, s.Topic, time.Now())
				}
			}
		}
	}
	if err := emit(protocol.NewRows(commandRows(planned, refused))); err != nil {
		return err
	}
	return emit(protocol.NewDone(len(planned), false))
}
