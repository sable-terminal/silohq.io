//go:build !sovereign

package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"sort"
	"strings"
	"time"

	"silohq.io/agent/internal/config"
	"silohq.io/agent/internal/discovery"
	"silohq.io/agent/internal/identity"
	"silohq.io/agent/internal/protocol"
	"silohq.io/agent/internal/tunnel"
	"silohq.io/agent/internal/work"
)

// plugins are the industrial plugins as discovery uses them (spec 20.1: discover is one of their verbs).
type plugins struct {
	servers *work.OPCUA
	brokers *work.MQTT
}

func (p plugins) BrowseOPCUA(ctx context.Context, server protocol.OPCUAServer) (*protocol.OPCUAStructure, *protocol.Error) {
	return p.servers.Browse(ctx, server)
}

func (p plugins) ObserveMQTT(ctx context.Context, connectionID, endpointURL string, credential *protocol.SealedLogin, window time.Duration) (*protocol.MQTTStructure, *protocol.Error) {
	return p.brokers.Observe(ctx, connectionID, endpointURL, credential, window)
}

// introspectable says whether discovery reads this held DSN's catalogue (a key=value DSN is Postgres's).
func introspectable(dsn string) bool {
	for _, prefix := range []string{"postgres://", "postgresql://", "mysql://", "mariadb://", "sqlserver://", "oracle://"} {
		if strings.HasPrefix(dsn, prefix) {
			return true
		}
	}
	return false
}

// discoveryBuilt says this build carries discovery (spec 19: the sovereign build does not).
const discoveryBuilt = true

// discoveryModule is discovery as the agent runs it: work kind discovery.scan, on scans the
// cell signed (spec 10.5), unless the host switched it off.
type discoveryModule struct {
	verifier *discovery.Verifier
	handler  tunnel.Handler
}

func newDiscovery(c *config.Config, id identity.Identity, logger *slog.Logger, servers *work.OPCUA, brokers *work.MQTT) (*discoveryModule, error) {
	key, err := identity.LoadDiscoveryKey(c.StateDir)
	if err != nil {
		return nil, err
	}
	verifier, err := discovery.NewVerifier(key, id.OrganisationID, id.AgentID)
	if err != nil {
		return nil, err
	}
	settings := discovery.Settings{
		Ports: c.DiscoveryPorts, ConfigPaths: c.DiscoveryConfigPaths, Logger: logger,
		// The database connections this agent holds credentials for, read as a scan begins:
		// Postgres, MySQL (and MariaDB), SQL Server and Oracle catalogues are introspected.
		Databases: func() map[string]string {
			held := map[string]string{}
			for connectionID := range c.Connections {
				dsn, ok, err := c.DSN(connectionID)
				if !ok || err != nil || (strings.Contains(dsn, "://") && !introspectable(dsn)) {
					continue
				}
				held[connectionID] = dsn
			}
			return held
		},
		Industrial: plugins{servers: servers, brokers: brokers},
	}
	m := &discoveryModule{verifier: verifier}
	m.handler = func(ctx context.Context, payload json.RawMessage, emit func(any) error) error {
		refuse := func(reason string) error {
			logger.Warn("a discovery scan was refused", "event", "agent.discovery_refused", "reason", reason)
			return emit(discovery.End{Type: "end", Status: "failed", Reason: "refused:" + reason})
		}
		// Off means unreachable, whatever the cell authorised (spec 19.1).
		if c.DiscoveryDisabled {
			return refuse("disabled_locally")
		}
		var given struct {
			Scan *discovery.Signed `json:"scan"`
			// The organisation's industrial endpoints in the scan's targets, their logins and keys sealed for the scan.
			Industrial []protocol.DiscoveryEndpoint `json:"industrial"`
		}
		if err := json.Unmarshal(payload, &given); err != nil {
			return refuse("unsigned")
		}
		scan, a, reason := verifier.Check(given.Scan)
		if reason != "" {
			return refuse(reason)
		}
		methods := append([]string(nil), a.Methods...)
		sort.Strings(methods)
		// What was authorised, by whom, never what was found (spec 10.8).
		logger.Info("discovery scan started", "event", "agent.discovery_started", "scan_id", scan.ScanID, "authorisation_id", a.ID,
			"authorised_by", a.AuthorisedBy, "methods", strings.Join(methods, ","), "targets", len(a.Ranges), "max_hosts", a.MaxHosts)
		scanSettings := settings
		scanSettings.Endpoints = given.Industrial
		// The logins and keys were sealed for the scan: it is their work.
		err := discovery.Run(protocol.WithWorkID(ctx, scan.ScanID), scanSettings, a, emit)
		outcome := "ended"
		if err != nil {
			outcome = "stopped"
		}
		logger.Info("discovery scan "+outcome, "event", "agent.discovery_"+outcome, "scan_id", scan.ScanID)
		return err
	}
	return m, nil
}

// useKey takes the key the cell sent at a renewal.
func (m *discoveryModule) useKey(c *config.Config, keyPEM string) {
	if err := identity.SaveDiscoveryKey(c.StateDir, keyPEM); err == nil {
		_ = m.verifier.Use(keyPEM)
	}
}
