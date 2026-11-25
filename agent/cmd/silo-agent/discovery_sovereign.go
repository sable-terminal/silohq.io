//go:build sovereign

package main

import (
	"log/slog"

	"silohq.io/agent/internal/config"
	"silohq.io/agent/internal/identity"
	"silohq.io/agent/internal/tunnel"
	"silohq.io/agent/internal/work"
)

// The sovereign build has no discovery (spec 19): no handler, no scan key, and the heartbeat
// says discovery is off, so the cell never asks.
const discoveryBuilt = false

type discoveryModule struct {
	handler tunnel.Handler
}

func newDiscovery(*config.Config, identity.Identity, *slog.Logger, *work.OPCUA, *work.MQTT) (*discoveryModule, error) {
	return nil, nil
}

func (*discoveryModule) useKey(*config.Config, string) {}
