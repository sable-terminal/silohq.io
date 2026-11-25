// Package config reads the agent's one configuration file (spec 10.1: "configured by one
// file"), JSON. It may hold agent-held credentials (spec 10.7: "an agent-only file"), so it
// must not be readable by anyone but the agent's own user: a file group or world can read is
// refused on Unix.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"silohq.io/agent/internal/login"
)

// Connection is how this agent reaches one connection's system, with an agent-held credential.
type Connection struct {
	// DSN is a database URL, credentials included (postgres://user:password@host:5432/db?sslmode=verify-full).
	DSN string `json:"dsn,omitempty"`
	// DSNFile names a file holding the DSN instead, under the same rule as this file.
	DSNFile string `json:"dsnFile,omitempty"`
	// ReplicationDSN is the customer's read-only replication login, for change capture (spec 10.4).
	ReplicationDSN     string `json:"replicationDsn,omitempty"`
	ReplicationDSNFile string `json:"replicationDsnFile,omitempty"`
}

type Config struct {
	// Endpoint is agent.<cell>:443, the one host and port the agent connects to.
	Endpoint string `json:"endpoint"`
	// ServerName is the endpoint's TLS name, by default the endpoint's host.
	ServerName string `json:"serverName,omitempty"`
	// EndpointCAFile pins the endpoint's certificate authority; by default the system's roots.
	EndpointCAFile string `json:"endpointCaFile,omitempty"`
	// StateDir holds the agent's key, certificate and identity.
	StateDir string `json:"stateDir"`
	Name     string `json:"name"`
	// Proxy is an HTTP CONNECT proxy (spec 10.2), when the network needs one.
	Proxy string `json:"proxy,omitempty"`
	// HealthListen is the loopback health endpoint's address, 127.0.0.1:9440 by default.
	HealthListen string `json:"healthListen,omitempty"`
	// DiscoveryDisabled switches discovery off whatever the cell authorises (spec 10.5).
	DiscoveryDisabled bool `json:"discoveryDisabled,omitempty"`
	// DiscoveryPorts are the ports a port scan tries, in place of the usual ones; the host's
	// choice, never the cell's.
	DiscoveryPorts []int `json:"discoveryPorts,omitempty"`
	// DiscoveryConfigPaths are further files host configuration may read for systems they name.
	DiscoveryConfigPaths []string `json:"discoveryConfigPaths,omitempty"`
	// Targets are the systems the cell may send this agent to with a login it keeps (spec 10.7):
	// host names, *.suffix, addresses and networks. None: only connections this agent holds the
	// login for, each at its own address.
	Targets []string `json:"targets,omitempty"`
	// FileRoots are the directories a file share may be read beneath (spec 14.4, 10.4): absolute
	// paths on this host, a share mounted here among them. None: no file share is read.
	FileRoots []string `json:"fileRoots,omitempty"`
	// WebhookCAFile adds certificate authorities a private webhook target's certificate may chain
	// to (spec 20.4): a customer's internal CA, trusted with the system's roots.
	WebhookCAFile string `json:"webhookCaFile,omitempty"`
	// MaxConcurrentCalls bounds the calls at once (spec 10.7: 32 by default).
	MaxConcurrentCalls int `json:"maxConcurrentCalls,omitempty"`
	// MemoryLimitMB is the soft memory limit (spec 10.7: 512, up to 4096).
	MemoryLimitMB int `json:"memoryLimitMb,omitempty"`
	// SpoolMaxMB and SpoolMaxDays bound the store-and-forward spool (spec 10.6: 10 GB, 7 days;
	// 30 days where AirGapped).
	SpoolMaxMB   int                   `json:"spoolMaxMb,omitempty"`
	SpoolMaxDays int                   `json:"spoolMaxDays,omitempty"`
	AirGapped    bool                  `json:"airGapped,omitempty"`
	Connections  map[string]Connection `json:"connections,omitempty"`
}

// Load reads and checks the file.
func Load(path string) (*Config, error) {
	if err := privateFile(path); err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("cannot read the configuration: %w", err)
	}
	var c Config
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&c); err != nil {
		return nil, fmt.Errorf("the configuration is not valid JSON for this agent: %w", err)
	}
	if err := c.check(); err != nil {
		return nil, err
	}
	return &c, nil
}

func (c *Config) check() error {
	host, port, err := net.SplitHostPort(c.Endpoint)
	if err != nil || host == "" || port == "" {
		return errors.New("endpoint is agent.<cell>:443, a host and a port")
	}
	if c.ServerName == "" {
		c.ServerName = host
	}
	if c.StateDir == "" {
		return errors.New("stateDir is where the agent keeps its key and certificate")
	}
	if strings.TrimSpace(c.Name) == "" || len(c.Name) > 100 {
		return errors.New("name names this agent, 1 to 100 characters")
	}
	if c.Proxy != "" {
		if u, err := url.Parse(c.Proxy); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return errors.New("proxy is an http:// or https:// URL")
		}
	}
	if c.HealthListen == "" {
		c.HealthListen = "127.0.0.1:9440"
	}
	if h, _, err := net.SplitHostPort(c.HealthListen); err != nil || (h != "127.0.0.1" && h != "::1" && h != "localhost") {
		return errors.New("healthListen is a loopback address: the agent listens on nothing else (spec 10.2)")
	}
	if c.MaxConcurrentCalls == 0 {
		c.MaxConcurrentCalls = 32
	}
	if c.MaxConcurrentCalls < 1 || c.MaxConcurrentCalls > 256 {
		return errors.New("maxConcurrentCalls is 1 to 256")
	}
	if c.MemoryLimitMB == 0 {
		c.MemoryLimitMB = 512
	}
	if c.MemoryLimitMB < 128 || c.MemoryLimitMB > 4096 {
		return errors.New("memoryLimitMb is 128 to 4096")
	}
	if c.SpoolMaxMB == 0 {
		c.SpoolMaxMB = 10 * 1024
	}
	if c.SpoolMaxMB < 1 || c.SpoolMaxMB > 1024*1024 {
		return errors.New("spoolMaxMb is 1 to 1048576")
	}
	if c.SpoolMaxDays == 0 {
		c.SpoolMaxDays = 7
		if c.AirGapped {
			c.SpoolMaxDays = 30
		}
	}
	if c.SpoolMaxDays < 1 || c.SpoolMaxDays > 90 {
		return errors.New("spoolMaxDays is 1 to 90")
	}
	if len(c.DiscoveryPorts) > 200 {
		return errors.New("discoveryPorts names at most 200 ports")
	}
	for _, port := range c.DiscoveryPorts {
		if port < 1 || port > 65535 {
			return errors.New("discoveryPorts are ports, 1 to 65535")
		}
	}
	for _, path := range c.DiscoveryConfigPaths {
		if !filepath.IsAbs(path) {
			return errors.New("discoveryConfigPaths are absolute paths")
		}
	}
	if len(c.Targets) > 500 {
		return errors.New("targets names at most 500 entries")
	}
	if _, err := login.ParseTargets(c.Targets); err != nil {
		return fmt.Errorf("targets: %w", err)
	}
	if len(c.FileRoots) > 100 {
		return errors.New("fileRoots names at most 100 directories")
	}
	for _, root := range c.FileRoots {
		if !filepath.IsAbs(root) || filepath.Clean(root) == string(filepath.Separator) {
			return errors.New("fileRoots are absolute directories, never the file system's root")
		}
	}
	for id, conn := range c.Connections {
		if (conn.DSN == "") == (conn.DSNFile == "") {
			return fmt.Errorf("connection %s: give dsn or dsnFile, one of them", id)
		}
		if conn.ReplicationDSN != "" && conn.ReplicationDSNFile != "" {
			return fmt.Errorf("connection %s: give replicationDsn or replicationDsnFile, not both", id)
		}
	}
	return nil
}

// DSN is the connection's DSN, read from its file where it names one.
func (c *Config) DSN(connectionID string) (string, bool, error) {
	conn, ok := c.Connections[connectionID]
	if !ok {
		return "", false, nil
	}
	if conn.DSN != "" {
		return conn.DSN, true, nil
	}
	if err := privateFile(conn.DSNFile); err != nil {
		return "", true, err
	}
	raw, err := os.ReadFile(conn.DSNFile)
	if err != nil {
		return "", true, fmt.Errorf("cannot read the connection's DSN file: %w", err)
	}
	return strings.TrimSpace(string(raw)), true, nil
}

// ReplicationDSN is the connection's replication login, read from its file where it names one.
func (c *Config) ReplicationDSN(connectionID string) (string, bool, error) {
	conn, ok := c.Connections[connectionID]
	if !ok || (conn.ReplicationDSN == "" && conn.ReplicationDSNFile == "") {
		return "", false, nil
	}
	if conn.ReplicationDSN != "" {
		return conn.ReplicationDSN, true, nil
	}
	if err := privateFile(conn.ReplicationDSNFile); err != nil {
		return "", true, err
	}
	raw, err := os.ReadFile(conn.ReplicationDSNFile)
	if err != nil {
		return "", true, fmt.Errorf("cannot read the connection's replication DSN file: %w", err)
	}
	return strings.TrimSpace(string(raw)), true, nil
}

// privateFile refuses a file that anyone but its owner may read (Unix permissions).
func privateFile(path string) error {
	info, err := os.Stat(path)
	if err != nil {
		return fmt.Errorf("cannot read %s: %w", path, err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("%s may be read by others (%v): make it readable by the agent's user alone (chmod 600)", path, info.Mode().Perm())
	}
	return nil
}
