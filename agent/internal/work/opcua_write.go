package work

// Write (spec 47.1, 47.4, 47.5, 47.6): opcua.write sets setpoints on a server, as a physical
// Action's execution, and only on the grant actions signed for exactly these statements. Each
// statement is one record (an instance under the root, by browse name) and the values for the
// variables at its fields' browse paths. Before anything is written, every node must be in
// this agent's current signed allow-list for the connection, as a setpoint, its value within
// the entry's range, its step from the value read now no larger than the entry's, its last
// write at least the entry's interval ago, and the plan within the connection's writes a
// minute: one refusal and nothing at all is written (each statement says why or that it was
// not attempted). Then each statement's nodes are written in one request: a status the server
// returns that is not good is the control system's rejection, which is the outcome and is
// never retried. The value is sent as the variable's own data type.
//
// A dry run (47.5), which the grant covers as part of the statements, writes each node's
// simulator counterpart, the one its signed entry names, and nothing in production: a node
// whose entry names none is refused (no_simulator). Range and step still hold, against the
// simulator's value now; the interval and the rate are production's and do not count a dry
// run. The simulator is read back after the write, for verification.

import (
	"bytes"
	"context"
	"encoding/json"
	"math"
	"math/big"
	"strings"
	"sync"
	"time"

	"github.com/gopcua/opcua"
	"github.com/gopcua/opcua/ua"

	"silohq.io/agent/internal/actuation"
	"silohq.io/agent/internal/grant"
	"silohq.io/agent/internal/protocol"
)

const maxPhysicalStatements = 100

type opcuaWrite struct {
	protocol.OPCUAServer
	Root           string          `json:"root"`
	TypeDefinition string          `json:"typeDefinition,omitempty"`
	Statements     json.RawMessage `json:"statements"`
	Grant          *grant.Signed   `json:"grant"`
}

type physicalStatement struct {
	Key      string `json:"key"`
	Instance string `json:"instance"`
	Writes   []struct {
		Path  string `json:"path"`
		Value any    `json:"value"`
	} `json:"writes"`
	// MaxPerMinute is the connection's physical writes a minute; 0 is none set.
	MaxPerMinute int `json:"maxPerMinute"`
	// DryRun writes the simulator nodes the entries name, never production (47.5).
	DryRun bool `json:"dryRun,omitempty"`
}

// writeLog is the physical writes made here: the last per node, and the connection's in the last minute.
type writeLog struct {
	mu     sync.Mutex
	last   map[string]time.Time
	recent map[string][]time.Time
}

func (l *writeLog) lastWrite(connectionID, address string) (time.Time, bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	t, ok := l.last[connectionID+"\x00"+address]
	return t, ok
}

func (l *writeLog) inLastMinute(connectionID string, now time.Time) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	kept := l.recent[connectionID][:0]
	for _, t := range l.recent[connectionID] {
		if now.Sub(t) < time.Minute {
			kept = append(kept, t)
		}
	}
	l.recent[connectionID] = kept
	return len(kept)
}

func (l *writeLog) wrote(connectionID, address string, at time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.last[connectionID+"\x00"+address] = at
	l.recent[connectionID] = append(l.recent[connectionID], at)
}

type plannedNode struct {
	path    string
	node    *ua.NodeID
	address string
	entry   actuation.Entry
	value   any
	status  string
	// A dry run's: the simulator node written instead, and what it read back.
	simulator string
	observed  any
}

type plannedStatement struct {
	key     string
	nodes   []*plannedNode
	refusal string
	dryRun  bool
}

// rat reads a JSON number or a numeric value exactly.
func rat(v any) (*big.Rat, bool) {
	switch n := v.(type) {
	case json.Number:
		return new(big.Rat).SetString(n.String())
	case float64:
		if math.IsNaN(n) || math.IsInf(n, 0) {
			return nil, false
		}
		return new(big.Rat).SetFloat64(n), true
	case float32:
		return new(big.Rat).SetFloat64(float64(n)), true
	case int8, int16, int32, int64, uint8, uint16, uint32, uint64:
		r, ok := new(big.Rat).SetString(strings.TrimSpace(jsonText(n)))
		return r, ok
	}
	return nil, false
}

func jsonText(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

// asType is a JSON value as the variable's data type, or false where it does not fit.
func asType(value any, dataType uint32) (any, bool) {
	whole := func(lo, hi int64) (int64, bool) {
		r, ok := rat(value)
		if !ok || !r.IsInt() || !r.Num().IsInt64() {
			return 0, false
		}
		n := r.Num().Int64()
		return n, n >= lo && n <= hi
	}
	switch dataType {
	case 1: // Boolean
		b, ok := value.(bool)
		return b, ok
	case 2:
		n, ok := whole(math.MinInt8, math.MaxInt8)
		return int8(n), ok
	case 3:
		n, ok := whole(0, math.MaxUint8)
		return uint8(n), ok
	case 4:
		n, ok := whole(math.MinInt16, math.MaxInt16)
		return int16(n), ok
	case 5:
		n, ok := whole(0, math.MaxUint16)
		return uint16(n), ok
	case 6:
		n, ok := whole(math.MinInt32, math.MaxInt32)
		return int32(n), ok
	case 7:
		n, ok := whole(0, math.MaxUint32)
		return uint32(n), ok
	case 8:
		n, ok := whole(math.MinInt64, math.MaxInt64)
		return n, ok
	case 10, 11: // Float, Double
		r, ok := rat(value)
		if !ok {
			return nil, false
		}
		f, _ := r.Float64()
		if dataType == 10 {
			return float32(f), true
		}
		return f, true
	case 12: // String
		s, ok := value.(string)
		return s, ok
	}
	return nil, false
}

// Write runs an opcua.write and emits a row per statement, then done; or one error frame.
func (o *OPCUA) Write(ctx context.Context, payload json.RawMessage, emit Emit) error {
	var work opcuaWrite
	if err := json.Unmarshal(payload, &work); err != nil {
		return emit(protocol.NewError(protocol.Integrity, ""))
	}
	var statements []physicalStatement
	decoder := json.NewDecoder(bytes.NewReader(work.Statements))
	decoder.UseNumber()
	if err := decoder.Decode(&statements); err != nil || len(statements) == 0 || len(statements) > maxPhysicalStatements {
		return emit(protocol.NewError(protocol.Integrity, ""))
	}
	if _, _, ok := parseNodeAddress(work.Root); !ok {
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
	var typeDef *ua.NodeID
	if work.TypeDefinition != "" {
		if typeDef, ok = sess.resolve(work.TypeDefinition); !ok {
			return emit(protocol.NewError(protocol.SourceRefused, ""))
		}
	}
	instances, err := sess.children(ctx, root)
	if err != nil {
		return emit(protocol.NewError(protocol.SourceRefused, ""))
	}
	byName := map[string]*ua.NodeID{}
	for _, i := range instances {
		if typeDef != nil && (i.typeDef == nil || i.typeDef.String() != typeDef.String()) {
			continue
		}
		byName[i.browseName] = i.id
	}
	// The plan: every node found, listed and read before anything is written.
	planned := make([]*plannedStatement, 0, len(statements))
	var reads []*ua.ReadValueID
	var all []*plannedNode
	for _, s := range statements {
		p := &plannedStatement{key: s.Key, dryRun: s.DryRun}
		planned = append(planned, p)
		instance, found := byName[s.Instance]
		if !found || len(s.Writes) == 0 {
			p.refusal = "instance"
			continue
		}
		for _, w := range s.Writes {
			if !validPath(w.Path) || strings.HasPrefix(w.Path, "$") {
				p.refusal = "node"
				break
			}
			node, found, err := sess.walk(ctx, instance, w.Path)
			if err != nil {
				return emit(protocol.NewError(protocol.SourceRefused, ""))
			}
			if !found {
				p.refusal = "node"
				break
			}
			address := sess.address(node)
			entry, listed := actuation.Entry{}, false
			if o.Allowlists != nil {
				entry, listed = o.Allowlists.Lookup(work.ConnectionID, "opcua", address)
			}
			n := &plannedNode{path: w.Path, node: node, address: address, entry: entry, value: w.Value}
			// Named in the answer even when refused: the cell raises exactly which node.
			p.nodes = append(p.nodes, n)
			if !listed {
				p.refusal = "not_listed"
				break
			}
			if entry.Kind != "setpoint" {
				p.refusal = "kind"
				break
			}
			if s.DryRun {
				// The simulator counterpart the signed entry names, never production.
				var sim *ua.NodeID
				if entry.SimulatorAddress != nil {
					sim, _ = sess.resolve(*entry.SimulatorAddress)
				}
				if sim == nil {
					p.refusal = "no_simulator"
					break
				}
				n.node, n.simulator = sim, *entry.SimulatorAddress
			}
			all = append(all, n)
			reads = append(reads, &ua.ReadValueID{NodeID: n.node, AttributeID: ua.AttributeIDDataType}, &ua.ReadValueID{NodeID: n.node, AttributeID: ua.AttributeIDValue})
		}
	}
	current := map[*plannedNode]*ua.Variant{}
	dataTypes := map[*plannedNode]uint32{}
	for start := 0; start < len(reads); start += opcuaReadChunk {
		end := min(start+opcuaReadChunk, len(reads))
		res, err := sess.client.Read(ctx, &ua.ReadRequest{NodesToRead: reads[start:end], TimestampsToReturn: ua.TimestampsToReturnNeither})
		if err != nil || len(res.Results) != end-start {
			return emit(protocol.NewError(protocol.SourceRefused, ""))
		}
		for i := 0; i < len(res.Results); i += 2 {
			n := all[(start+i)/2]
			if dt := res.Results[i]; dt.Status == ua.StatusOK && dt.Value != nil {
				if id, ok := dt.Value.Value().(*ua.NodeID); ok && id.Namespace() == 0 {
					dataTypes[n] = id.IntID()
				}
			}
			if v := res.Results[i+1]; v.Status == ua.StatusOK {
				current[n] = v.Value
			}
		}
	}
	now := time.Now()
	planWrites := 0
	for _, p := range planned {
		for _, n := range p.nodes {
			if p.refusal != "" {
				break
			}
			typed, fits := asType(n.value, dataTypes[n])
			if !fits {
				p.refusal = "data_type"
				break
			}
			n.value = typed
			if reason := o.withinEntry(work.ConnectionID, n, current[n], now, p.dryRun); reason != "" {
				p.refusal = reason
			}
			if !p.dryRun {
				planWrites++
			}
		}
	}
	perMinute := statements[0].MaxPerMinute
	if perMinute > 0 && o.writes.inLastMinute(work.ConnectionID, now)+planWrites > perMinute {
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
			o.writeStatement(ctx, sess.client, work.ConnectionID, p)
			if p.dryRun {
				o.readBack(ctx, sess.client, p)
			}
		}
	}
	rows := make([]map[string]any, 0, len(planned))
	for _, p := range planned {
		outcome := "applied"
		switch {
		case p.refusal != "":
			outcome = "refused"
		case refused:
			outcome = "not_attempted"
		default:
			for _, n := range p.nodes {
				switch {
				case n.status == "bad":
					outcome = "rejected"
				case n.status == "unknown" && outcome == "applied":
					// Read back decides whether it landed: never a retry.
					outcome = "unknown"
				}
			}
		}
		nodes := make([]map[string]any, 0, len(p.nodes))
		for _, n := range p.nodes {
			node := map[string]any{"path": n.path, "nodeAddress": n.address, "entryId": n.entry.ID, "status": n.status}
			if p.dryRun && n.simulator != "" {
				node["simulatorAddress"] = n.simulator
				node["observed"] = n.observed
			}
			nodes = append(nodes, node)
		}
		row := map[string]any{"key": p.key, "outcome": outcome, "nodes": nodes}
		if p.refusal != "" {
			row["reason"] = p.refusal
		}
		rows = append(rows, row)
	}
	if err := emit(protocol.NewRows(rows)); err != nil {
		return err
	}
	return emit(protocol.NewDone(len(rows), false))
}

// withinEntry says why a value breaks its entry (range, step from the value now, interval), or "".
func (o *OPCUA) withinEntry(connectionID string, n *plannedNode, now_ *ua.Variant, at time.Time, dryRun bool) string {
	if n.entry.MinValue != nil || n.entry.MaxStep != nil {
		value, ok := rat(n.value)
		if !ok {
			return "range"
		}
		lo, okLo := actuation.Decimal(n.entry.MinValue)
		hi, okHi := actuation.Decimal(n.entry.MaxValue)
		if !okLo || !okHi || (lo != nil && (value.Cmp(lo) < 0 || value.Cmp(hi) > 0)) {
			return "range"
		}
		if n.entry.MaxStep != nil {
			step, okStep := actuation.Decimal(n.entry.MaxStep)
			var current *big.Rat
			if now_ != nil {
				current, ok = rat(now_.Value())
			}
			if !okStep || current == nil || !ok || new(big.Rat).Abs(new(big.Rat).Sub(value, current)).Cmp(step) > 0 {
				return "step"
			}
		}
	}
	if last, wrote := o.writes.lastWrite(connectionID, n.address); !dryRun && wrote && at.Sub(last) < time.Duration(n.entry.MinIntervalSeconds)*time.Second {
		return "interval"
	}
	return ""
}

// writeStatement writes one statement's nodes in one request; a status not good is the control
// system's rejection. Applied nodes are logged for the interval and the rate.
func (o *OPCUA) writeStatement(ctx context.Context, client *opcua.Client, connectionID string, p *plannedStatement) {
	request := &ua.WriteRequest{}
	for _, n := range p.nodes {
		variant, err := ua.NewVariant(n.value)
		if err != nil {
			n.status = "bad"
			continue
		}
		request.NodesToWrite = append(request.NodesToWrite, &ua.WriteValue{
			NodeID: n.node, AttributeID: ua.AttributeIDValue, Value: &ua.DataValue{EncodingMask: ua.DataValueValue, Value: variant},
		})
	}
	res, err := client.Write(ctx, request)
	at := time.Now()
	i := 0
	for _, n := range p.nodes {
		if n.status == "bad" {
			continue
		}
		switch {
		case err != nil || res == nil || i >= len(res.Results):
			// No answer: the write may or may not have landed; read back decides, never a retry.
			n.status = "unknown"
		case res.Results[i] == ua.StatusOK || uint32(res.Results[i])&0xC0000000 == 0:
			n.status = "good"
			if !p.dryRun {
				o.writes.wrote(connectionID, n.address, at)
			}
		default:
			n.status = "bad"
		}
		i++
	}
}

// readBack reads a dry run's simulator nodes after the write: what verification compares (47.5).
func (o *OPCUA) readBack(ctx context.Context, client *opcua.Client, p *plannedStatement) {
	reads := make([]*ua.ReadValueID, 0, len(p.nodes))
	for _, n := range p.nodes {
		reads = append(reads, &ua.ReadValueID{NodeID: n.node, AttributeID: ua.AttributeIDValue})
	}
	res, err := client.Read(ctx, &ua.ReadRequest{NodesToRead: reads, TimestampsToReturn: ua.TimestampsToReturnNeither})
	if err != nil || len(res.Results) != len(p.nodes) {
		return
	}
	for i, n := range p.nodes {
		if res.Results[i].Status == ua.StatusOK {
			n.observed = jsonValue(res.Results[i].Value)
		}
	}
}
