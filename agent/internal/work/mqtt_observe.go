package work

// Observe (spec 19.2, 19.3, 20.2): discovery's look at a broker the organisation already
// connects to. It subscribes to every topic (#, which takes no $ topics) for a window, and of
// each message keeps its topic and its payload's shape (a JSON object's field names and JSON
// types; a Sparkplug B payload's metric names and types; else text or binary) in memory; the payload itself is discarded at once and never
// leaves the agent. Topics are gathered into families: a level that is an identifier (a
// number, a UUID, a long hex string), or that varies among topics otherwise alike, becomes +.
// Bounded: 10,000 messages and 2,000 topics.

import (
	"context"
	"encoding/json"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	paho "github.com/eclipse/paho.mqtt.golang"

	"silohq.io/agent/internal/protocol"
)

const (
	maxObservedMessages = 10_000
	maxObservedTopics   = 2_000
	maxObserveWindow    = 60 * time.Second
	// A level varying among this many topics otherwise alike is an identifier.
	variesAmong = 3
)

var identifierLevel = regexp.MustCompile(`^(\d+|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{12,})$`)

type topicShape struct {
	payload string
	fields  map[string]string
}

// shapeOf is a payload's shape: never its values. On a Sparkplug B topic, its metrics' names and types (D211).
func shapeOf(topic string, payload []byte) topicShape {
	if isSparkplugTopic(topic) {
		if fields, err := sparkplugShape(payload); err == nil {
			return topicShape{payload: "sparkplug_b", fields: fields}
		}
		return topicShape{payload: "binary"}
	}
	var object map[string]any
	if err := json.Unmarshal(payload, &object); err == nil && object != nil {
		fields := make(map[string]string, len(object))
		for name, value := range object {
			fields[name] = jsonType(value)
		}
		return topicShape{payload: "json", fields: fields}
	}
	if utf8.Valid(payload) {
		return topicShape{payload: "text"}
	}
	return topicShape{payload: "binary"}
}

func jsonType(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case bool:
		return "boolean"
	case float64:
		return "number"
	case string:
		return "string"
	case []any:
		return "array"
	default:
		return "object"
	}
}

// Observe watches the broker for window and returns its topic families.
func (m *MQTT) Observe(ctx context.Context, connectionID, endpointURL string, credential *protocol.SealedLogin, window time.Duration) (*protocol.MQTTStructure, *protocol.Error) {
	if window <= 0 || window > maxObserveWindow {
		window = 10 * time.Second
	}
	work := protocol.WorkID(ctx)
	sess, refusal := m.connect(ctx, endpointURL, []protocol.MQTTTopic{{Filter: "#", QoS: 0}}, credential, connectionID, work,
		"silo-d"+strings.ReplaceAll(work, "-", ""), nil)
	if refusal != nil {
		return nil, refusal
	}
	defer sess.close()
	var (
		mu        sync.Mutex
		topics    = map[string]topicShape{}
		messages  int
		truncated bool
		full      = make(chan struct{})
		once      sync.Once
	)
	handler := func(_ paho.Client, msg paho.Message) {
		shape := shapeOf(msg.Topic(), msg.Payload())
		mu.Lock()
		defer mu.Unlock()
		messages++
		if _, seen := topics[msg.Topic()]; !seen && len(topics) >= maxObservedTopics || messages > maxObservedMessages {
			truncated = true
			once.Do(func() { close(full) })
			return
		}
		if known, seen := topics[msg.Topic()]; seen && known.payload == shape.payload && (shape.payload == "json" || shape.payload == "sparkplug_b") {
			for name, typ := range shape.fields {
				if _, ok := known.fields[name]; !ok {
					known.fields[name] = typ
				}
			}
			return
		}
		topics[msg.Topic()] = shape
	}
	token := sess.client.Subscribe("#", 0, handler)
	if !token.WaitTimeout(10*time.Second) || token.Error() != nil {
		return nil, failed(protocol.SourceRefused)
	}
	select {
	case <-time.After(window):
	case <-full:
	case <-ctx.Done():
		return nil, failed(protocol.Timeout)
	}
	sess.client.Unsubscribe("#").WaitTimeout(2 * time.Second)
	mu.Lock()
	seen := make(map[string]topicShape, len(topics))
	for t, s := range topics {
		seen[t] = s
	}
	cut := truncated
	mu.Unlock()
	return &protocol.MQTTStructure{Families: families(seen), Truncated: cut}, nil
}

// families gathers topics into filters: identifier levels, and levels varying among topics
// otherwise alike, become +.
func families(topics map[string]topicShape) []protocol.MQTTFamily {
	type group struct {
		levels []string
		shape  topicShape
		topics int
	}
	groups := map[string]*group{}
	merge := func(key string, levels []string, shape topicShape, count int) {
		g := groups[key]
		if g == nil {
			groups[key] = &group{levels: levels, shape: topicShape{payload: shape.payload, fields: copyFields(shape.fields)}, topics: count}
			return
		}
		g.topics += count
		if g.shape.payload != shape.payload {
			g.shape = topicShape{payload: "text"}
			return
		}
		for name, typ := range shape.fields {
			if _, ok := g.shape.fields[name]; !ok {
				g.shape.fields[name] = typ
			}
		}
	}
	for topic, shape := range topics {
		levels := strings.Split(topic, "/")
		for i, level := range levels {
			if identifierLevel.MatchString(level) {
				levels[i] = "+"
			}
		}
		merge(strings.Join(levels, "/"), levels, shape, 1)
	}
	// A level varying among topics otherwise alike: + there, until nothing changes.
	for changed := true; changed; {
		changed = false
		byRest := map[string][]string{}
		for key, g := range groups {
			for i := range g.levels {
				if g.levels[i] == "+" {
					continue
				}
				rest := append(append([]string{}, g.levels[:i]...), append([]string{"+"}, g.levels[i+1:]...)...)
				byRest[strings.Join(rest, "/")] = append(byRest[strings.Join(rest, "/")], key)
			}
		}
		keys := make([]string, 0, len(byRest))
		for k := range byRest {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, rest := range keys {
			members := byRest[rest]
			if len(members) < variesAmong {
				continue
			}
			present := true
			for _, k := range members {
				if groups[k] == nil {
					present = false
				}
			}
			if !present {
				continue
			}
			for _, k := range members {
				g := groups[k]
				delete(groups, k)
				merge(rest, strings.Split(rest, "/"), g.shape, g.topics)
			}
			changed = true
		}
	}
	out := make([]protocol.MQTTFamily, 0, len(groups))
	for filter, g := range groups {
		f := protocol.MQTTFamily{Filter: filter, Topics: g.topics, Encoding: g.shape.payload, Fields: []protocol.MQTTFieldShape{}}
		names := make([]string, 0, len(g.shape.fields))
		for name := range g.shape.fields {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			f.Fields = append(f.Fields, protocol.MQTTFieldShape{Name: name, Type: g.shape.fields[name]})
		}
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Filter < out[j].Filter })
	return out
}

func copyFields(fields map[string]string) map[string]string {
	if fields == nil {
		return nil
	}
	out := make(map[string]string, len(fields))
	for k, v := range fields {
		out[k] = v
	}
	return out
}
