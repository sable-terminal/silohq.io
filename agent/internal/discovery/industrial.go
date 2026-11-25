package discovery

// Industrial discovery (spec 19.2, 19.3, 20.2, 20.3): OPC UA browse and MQTT topic observation,
// "where credentials already exist": only the organisation's industrial endpoints the cell sent
// with the scan, their logins and keys sealed for it, and only those whose host is one of the
// authorisation's targets (the host's own allowed targets are checked again by the plugin).
// Each endpoint is one probe and, where it answers, one finding: structure only. A payload is
// inspected for its shape in the plugin and discarded; no value or payload is reported.

import (
	"context"
	"net/url"
	"strconv"
	"time"

	"silohq.io/agent/internal/protocol"
)

// Industrial is the plugins' discovery: an OPC UA server browsed, a broker observed.
type Industrial interface {
	BrowseOPCUA(ctx context.Context, server protocol.OPCUAServer) (*protocol.OPCUAStructure, *protocol.Error)
	ObserveMQTT(ctx context.Context, connectionID, endpointURL string, credential *protocol.SealedLogin, window time.Duration) (*protocol.MQTTStructure, *protocol.Error)
}

// observeWindow is how long a broker is watched.
const observeWindow = 10 * time.Second

func endpointHost(raw string) (string, int, bool) {
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" {
		return "", 0, false
	}
	port, _ := strconv.Atoi(u.Port())
	return u.Hostname(), port, true
}

// refusalOutcome is a plugin's refusal as a probe's outcome.
func refusalOutcome(refusal *protocol.Error) string {
	switch refusal.Category {
	case protocol.SourceRefused, protocol.LoginRefused, protocol.TargetRefused:
		return Refused
	case protocol.SourceUnreachable, protocol.Timeout:
		return Closed
	default:
		return Error
	}
}

// industrial runs a method over the endpoints of its plugin.
func (r *run) industrial(method string) {
	plugin := map[string]string{MethodOPCUA: "opcua", MethodMQTT: "mqtt"}[method]
	for _, endpoint := range r.settings.Endpoints {
		if !r.going() {
			return
		}
		if endpoint.Plugin != plugin {
			continue
		}
		host, port, ok := endpointHost(endpoint.EndpointURL)
		if !ok {
			continue
		}
		if _, ok := r.targets.Match(r.ctx, host, r.settings.Resolve); !ok {
			continue
		}
		if !r.bound.admit(host) {
			return
		}
		select {
		case <-r.ctx.Done():
			return
		case <-r.pace:
		}
		found := Found{Protocol: "opc_ua", Schemas: []Schema{}, NodeClasses: []string{}, Topics: []string{}}
		if port > 0 {
			found.Port = intp(port)
		}
		var refusal *protocol.Error
		switch plugin {
		case "opcua":
			var structure *protocol.OPCUAStructure
			structure, refusal = r.settings.Industrial.BrowseOPCUA(r.ctx, endpoint.OPCUAServer)
			if refusal == nil {
				found.OPCUA = structure
				for _, t := range structure.Types {
					found.NodeClasses = append(found.NodeClasses, t.Name)
				}
			}
		case "mqtt":
			found.Protocol = "mqtt"
			var structure *protocol.MQTTStructure
			structure, refusal = r.settings.Industrial.ObserveMQTT(r.ctx, endpoint.ConnectionID, endpoint.EndpointURL, endpoint.Credential, observeWindow)
			if refusal == nil {
				found.MQTT = structure
				for _, f := range structure.Families {
					found.Topics = append(found.Topics, f.Filter)
				}
			}
		}
		if refusal != nil {
			if !r.probe(host, port, method, refusalOutcome(refusal)) {
				return
			}
			continue
		}
		if !r.probe(host, port, method, Identified) || !r.finding(host, method, found) {
			return
		}
	}
}
