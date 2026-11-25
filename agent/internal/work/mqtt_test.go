package work

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"silohq.io/agent/internal/actuation"
	"silohq.io/agent/internal/grant"
	"strings"
	"testing"
	"time"

	paho "github.com/eclipse/paho.mqtt.golang"

	"silohq.io/agent/internal/login"
	"silohq.io/agent/internal/protocol"
)

// The broker is the test environment's NATS with its MQTT listener (app/server/docker-compose.yml, mqtt).
const testBroker = "127.0.0.1:51883"

func brokerUp(t *testing.T) {
	t.Helper()
	conn, err := net.DialTimeout("tcp", testBroker, time.Second)
	if err != nil {
		t.Skip("the MQTT broker is not running (docker compose up -d mqtt)")
	}
	conn.Close()
}

func publish(t *testing.T, topic, payload string, retained bool) {
	t.Helper()
	client := paho.NewClient(paho.NewClientOptions().AddBroker("tcp://" + testBroker).SetClientID(fmt.Sprintf("pub-%d", time.Now().UnixNano())))
	if token := client.Connect(); !token.WaitTimeout(5*time.Second) || token.Error() != nil {
		t.Fatalf("connect: %v", token.Error())
	}
	defer client.Disconnect(100)
	if token := client.Publish(topic, 1, retained, payload); !token.WaitTimeout(5*time.Second) || token.Error() != nil {
		t.Fatalf("publish: %v", token.Error())
	}
}

func snapshot(t *testing.T, m *MQTT, snap protocol.MQTTSnapshot) []any {
	t.Helper()
	payload, _ := json.Marshal(snap)
	var frames []any
	ctx := protocol.WithWorkID(context.Background(), "0190f4a8-0000-7000-8000-000000000042")
	if err := m.Snapshot(ctx, payload, func(frame any) error { frames = append(frames, frame); return nil }); err != nil {
		t.Fatal(err)
	}
	return frames
}

func TestMQTTSnapshot(t *testing.T) {
	brokerUp(t)
	allowed, err := login.ParseTargets([]string{"127.0.0.0/8"})
	if err != nil {
		t.Fatal(err)
	}
	run := fmt.Sprintf("silo-test/%d", time.Now().UnixNano())
	publish(t, run+"/site/1/line/4/temp", `{"celsius":21.5}`, true)
	publish(t, run+"/site/2/line/7/temp", `{"celsius":19}`, true)
	publish(t, run+"/site/2/other", `{"x":1}`, true)

	m := NewMQTT(nil, allowed)
	go func() {
		time.Sleep(300 * time.Millisecond)
		publish(t, run+"/site/3/line/1/temp", `{"celsius":30}`, false)
	}()
	frames := snapshot(t, m, protocol.MQTTSnapshot{
		ConnectionID: "0190f4a8-0000-7000-8000-000000000001", EndpointURL: "tcp://" + testBroker,
		Topics: []protocol.MQTTTopic{{Filter: run + "/site/+/line/+/temp", QoS: 1}}, WindowMs: 1500, MaxMessages: 100,
	})
	if len(frames) != 2 {
		t.Fatalf("want rows then done, got %#v", frames)
	}
	rows := frames[0].(protocol.Rows).Rows
	got := map[string]string{}
	for _, row := range rows {
		payload, _ := base64.StdEncoding.DecodeString(row["payload"].(string))
		got[row["topic"].(string)] = string(payload)
		if row["retained"] != true {
			t.Errorf("a snapshot holds retained messages only: %v", row)
		}
	}
	want := map[string]string{run + "/site/1/line/4/temp": `{"celsius":21.5}`, run + "/site/2/line/7/temp": `{"celsius":19}`}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("retained messages on the filter only, the live publish not: got %v", got)
	}
	if done := frames[1].(protocol.Done); done.RowCount != 2 || done.Truncated {
		t.Errorf("done: %#v", done)
	}

	// More retained messages than maxMessages: reported truncated, never silently cut.
	cut := snapshot(t, m, protocol.MQTTSnapshot{
		ConnectionID: "0190f4a8-0000-7000-8000-000000000001", EndpointURL: "tcp://" + testBroker,
		Topics: []protocol.MQTTTopic{{Filter: run + "/#", QoS: 1}}, WindowMs: 1000, MaxMessages: 1,
	})
	if done := cut[len(cut)-1].(protocol.Done); !done.Truncated || done.RowCount != 1 {
		t.Errorf("want truncated after one, got %#v", done)
	}
}

func TestMQTTSnapshotRefusals(t *testing.T) {
	elsewhere, _ := login.ParseTargets([]string{"10.0.0.0/8"})
	allowed, _ := login.ParseTargets([]string{"127.0.0.0/8"})
	base := protocol.MQTTSnapshot{ConnectionID: "0190f4a8-0000-7000-8000-000000000001", EndpointURL: "tcp://" + testBroker,
		Topics: []protocol.MQTTTopic{{Filter: "a/+/b", QoS: 1}}, WindowMs: 100}
	if frames := snapshot(t, NewMQTT(nil, elsewhere), base); frames[0].(protocol.Error).Category != protocol.TargetRefused {
		t.Errorf("a broker the host's owner does not allow is refused: %#v", frames)
	}
	for _, filter := range []string{"a/#/b", "a/b+", "", "a/#x"} {
		bad := base
		bad.Topics = []protocol.MQTTTopic{{Filter: filter, QoS: 1}}
		if frames := snapshot(t, NewMQTT(nil, allowed), bad); frames[0].(protocol.Error).Category != protocol.Integrity {
			t.Errorf("filter %q: want integrity, got %#v", filter, frames)
		}
	}
	for _, endpoint := range []string{"http://127.0.0.1:1883", "tcp://user:pw@127.0.0.1:1883", "tcp://127.0.0.1:1883/x"} {
		bad := base
		bad.EndpointURL = endpoint
		if frames := snapshot(t, NewMQTT(nil, allowed), bad); frames[0].(protocol.Error).Category != protocol.Integrity {
			t.Errorf("endpoint %q: want integrity, got %#v", endpoint, frames)
		}
	}
}

func TestMQTTFamilies(t *testing.T) {
	json := func(fields ...string) topicShape {
		shape := topicShape{payload: "json", fields: map[string]string{}}
		for i := 0; i+1 < len(fields); i += 2 {
			shape.fields[fields[i]] = fields[i+1]
		}
		return shape
	}
	got := families(map[string]topicShape{
		"plant/site/1/line/4/temp": json("celsius", "number"),
		"plant/site/2/line/7/temp": json("celsius", "number", "ok", "boolean"),
		"plant/press/a/state":      {payload: "text"},
		"plant/press/b/state":      {payload: "text"},
		"plant/press/c/state":      {payload: "text"},
		"plant/hall/lights":        {payload: "text"},
		"plant/device/0190f4a8-0000-7000-8000-000000000001/blob": {payload: "binary"},
	})
	want := []protocol.MQTTFamily{
		{Filter: "plant/device/+/blob", Topics: 1, Encoding: "binary", Fields: []protocol.MQTTFieldShape{}},
		{Filter: "plant/hall/lights", Topics: 1, Encoding: "text", Fields: []protocol.MQTTFieldShape{}},
		{Filter: "plant/press/+/state", Topics: 3, Encoding: "text", Fields: []protocol.MQTTFieldShape{}},
		{Filter: "plant/site/+/line/+/temp", Topics: 2, Encoding: "json", Fields: []protocol.MQTTFieldShape{{Name: "celsius", Type: "number"}, {Name: "ok", Type: "boolean"}}},
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("families:\n got %v\nwant %v", got, want)
	}
}

func TestMQTTObserve(t *testing.T) {
	brokerUp(t)
	// The broker is shared: other tests' retained topics are observed too, so this test's own sit
	// under a level no other topic has, and its retained messages are cleared after.
	prefix := fmt.Sprintf("observe%d/observed", time.Now().UnixNano())
	topics := map[string]string{prefix + "/site/1/line/4/temp": `{"celsius":21.5,"ok":true}`, prefix + "/site/2/line/7/temp": `{"celsius":19}`, prefix + "/status": "online"}
	for topic, payload := range topics {
		publish(t, topic, payload, true)
	}
	defer func() {
		for topic := range topics {
			publish(t, topic, "", true)
		}
	}()
	allowed, _ := login.ParseTargets([]string{"127.0.0.0/8"})
	ctx := protocol.WithWorkID(context.Background(), "0190f4a8-0000-7000-8000-000000000044")
	found, refusal := NewMQTT(nil, allowed).Observe(ctx, "0190f4a8-0000-7000-8000-000000000001", "tcp://"+testBroker, nil, 1500*time.Millisecond)
	if refusal != nil {
		t.Fatalf("observe refused: %#v", refusal)
	}
	var mine []protocol.MQTTFamily
	for _, f := range found.Families {
		if strings.HasPrefix(f.Filter, prefix+"/") {
			mine = append(mine, f)
		}
	}
	want := fmt.Sprint([]protocol.MQTTFamily{
		{Filter: prefix + "/site/+/line/+/temp", Topics: 2, Encoding: "json", Fields: []protocol.MQTTFieldShape{{Name: "celsius", Type: "number"}, {Name: "ok", Type: "boolean"}}},
		{Filter: prefix + "/status", Topics: 1, Encoding: "text", Fields: []protocol.MQTTFieldShape{}},
	})
	if fmt.Sprint(mine) != want {
		t.Errorf("families:\n got %v\nwant %s", mine, want)
	}
	// No payload is in what was found.
	all, _ := json.Marshal(found)
	for _, value := range []string{"21.5", "online"} {
		if strings.Contains(string(all), value) {
			t.Errorf("a payload in the structure: %s", value)
		}
	}
}

func TestMQTTPublish(t *testing.T) {
	brokerUp(t)
	cp := newControlPlane(t)
	allowed, _ := login.ParseTargets([]string{"127.0.0.0/8"})
	m := NewMQTT(nil, allowed)
	m.Grants, _ = grant.NewVerifier(cp.pem, testOrgID)
	m.Allowlists, _ = actuation.NewStore(cp.pem, testOrgID)
	prefix := fmt.Sprintf("publish%d", time.Now().UnixNano())
	command := prefix + "/line/4/cmd/start"
	if reason := m.Allowlists.Replace(testConnID, []protocol.SignedEntry{
		cp.commandEntry("0190f4a8-0000-7000-8000-0000000000f4", "mqtt", command, "command", 60, fmt.Sprintf("%q", prefix+"/sim/line/4/cmd/start")),
	}); reason != "" {
		t.Fatal(reason)
	}
	// Watch the broker for what arrives.
	received := make(chan string, 10)
	watcher := paho.NewClient(paho.NewClientOptions().AddBroker("tcp://" + testBroker).SetClientID(fmt.Sprintf("watch-%d", time.Now().UnixNano())))
	if token := watcher.Connect(); !token.WaitTimeout(5*time.Second) || token.Error() != nil {
		t.Fatal(token.Error())
	}
	defer watcher.Disconnect(100)
	if token := watcher.Subscribe(prefix+"/#", 1, func(_ paho.Client, msg paho.Message) { received <- msg.Topic() + " " + string(msg.Payload()) }); !token.WaitTimeout(5 * time.Second) {
		t.Fatal("no subscription")
	}
	publish := func(topic string, dryRun bool) string {
		t.Helper()
		statements := fmt.Sprintf(`[{"key":"k1","topic":%q,"payload":"{\"run\":true}","qos":1,"retained":false,"maxPerMinute":10,"dryRun":%v}]`, topic, dryRun)
		payload, _ := json.Marshal(map[string]any{
			"connectionId": testConnID, "endpointUrl": "tcp://" + testBroker, "statements": json.RawMessage(statements), "grant": cp.grantFor(statements, 1),
		})
		var frames []any
		ctx := protocol.WithWorkID(context.Background(), fmt.Sprintf("0190f4a8-0000-7000-8000-%012d", time.Now().UnixNano()%1e12))
		if err := m.Publish(ctx, payload, func(frame any) error { frames = append(frames, frame); return nil }); err != nil {
			t.Fatal(err)
		}
		if e, ok := frames[0].(protocol.Error); ok {
			return e.Category + "/" + e.Reason
		}
		row := frames[0].(protocol.Rows).Rows[0]
		return fmt.Sprint(row["outcome"], "/", row["reason"])
	}
	if got := publish(command, false); got != "applied/<nil>" {
		t.Fatalf("a listed command: %s", got)
	}
	select {
	case got := <-received:
		if got != command+` {"run":true}` {
			t.Errorf("the broker received %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("nothing arrived")
	}
	if got := publish(command, false); got != "refused/interval" {
		t.Errorf("inside the interval: %s", got)
	}
	if got := publish(prefix+"/line/4/cmd/stop", false); got != "refused/not_listed" {
		t.Errorf("not listed: %s", got)
	}
	// A dry run publishes to the simulator topic the entry names, not production's.
	if got := publish(command, true); got != "applied/<nil>" {
		t.Errorf("a dry run: %s", got)
	}
	select {
	case got := <-received:
		if !strings.HasPrefix(got, prefix+"/sim/line/4/cmd/start ") {
			t.Errorf("the dry run went to %q", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the dry run did not arrive")
	}
}
