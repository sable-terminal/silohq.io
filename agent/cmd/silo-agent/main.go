// silo-agent: the Silo Agent (spec 10), one static binary in the customer's network.
//
//	silo-agent enrol -config agent.json -token silo_enr_...   once, with a token from the pool's page
//	silo-agent run   -config agent.json                       holds the tunnel; a service runs this
//	silo-agent version
//
// It connects outbound only and listens on nothing but its loopback health endpoint. `run`
// starts the agent as a child process of the installed binary, which restarts it onto an
// update it took and goes back when an update fails (spec 10.7; internal/update).
package main

import (
	"context"
	"crypto/x509"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"sync/atomic"
	"syscall"
	"time"

	"silohq.io/agent/internal/actuation"
	"silohq.io/agent/internal/config"
	"silohq.io/agent/internal/grant"
	"silohq.io/agent/internal/identity"
	"silohq.io/agent/internal/login"
	"silohq.io/agent/internal/protocol"
	"silohq.io/agent/internal/spool"
	"silohq.io/agent/internal/tunnel"
	"silohq.io/agent/internal/update"
	"silohq.io/agent/internal/work"
)

// Version is set at build time: -ldflags "-X main.Version=1.2.3".
var Version = "0.1.0"

func main() {
	// Spec 10.8: "Crash dumps are disabled."
	debug.SetTraceback("none")
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "enrol":
		err = enrol(logger, os.Args[2:])
	case "run":
		err = run(logger, os.Args[2:])
	case "version":
		fmt.Println(Version)
	default:
		usage()
	}
	if errors.Is(err, errRestart) {
		os.Exit(update.RestartCode)
	}
	if err != nil {
		logger.Error(err.Error(), "event", "agent.failed")
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: silo-agent enrol -config FILE -token TOKEN | run -config FILE | version")
	os.Exit(2)
}

func platform() string {
	if os.Getenv("SILO_AGENT_CONTAINER") == "1" {
		return "container"
	}
	switch runtime.GOOS + "/" + runtime.GOARCH {
	case "linux/amd64":
		return "linux_x86_64"
	case "linux/arm64":
		return "linux_arm64"
	case "windows/amd64":
		return "windows_x86_64"
	default:
		// Development builds report as Linux x86-64; release builds are only the platforms above.
		return "linux_x86_64"
	}
}

func settings(c *config.Config, logger *slog.Logger) (tunnel.Settings, error) {
	roots, err := tunnel.LoadRoots(c.EndpointCAFile)
	if err != nil {
		return tunnel.Settings{}, err
	}
	return tunnel.Settings{
		Endpoint: c.Endpoint, ServerName: c.ServerName, Roots: roots, Proxy: c.Proxy, Version: Version,
		DiscoveryDisabled: c.DiscoveryDisabled, MaxConcurrent: c.MaxConcurrentCalls, Logger: logger,
	}, nil
}

func enrol(logger *slog.Logger, args []string) error {
	flags := flag.NewFlagSet("enrol", flag.ExitOnError)
	path := flags.String("config", "agent.json", "configuration file")
	token := flags.String("token", "", "single-use enrolment token")
	_ = flags.Parse(args)
	if *token == "" {
		return errors.New("enrol needs -token, from the pool's page in Silo")
	}
	c, err := config.Load(*path)
	if err != nil {
		return err
	}
	s, err := settings(c, logger)
	if err != nil {
		return err
	}
	csr, key, err := identity.NewRequest(c.StateDir, c.Name)
	if err != nil {
		return err
	}
	sealingKey, err := identity.NewSealingKey(c.StateDir)
	if err != nil {
		return err
	}
	hostname, _ := os.Hostname()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	enrolled, err := tunnel.Enrol(ctx, s, protocol.EnrolRequest{
		Token: *token, CSR: csr, Name: c.Name, Hostname: hostname, Platform: platform(), Version: Version, SealingKey: sealingKey,
	})
	if err != nil {
		return err
	}
	if err := identity.TakeSealingKey(c.StateDir); err != nil {
		return err
	}
	if err := identity.Save(c.StateDir, key, enrolled.Certificate, enrolled.CACertificate, identity.Identity{
		AgentID: enrolled.AgentID, OrganisationID: enrolled.OrganisationID, PoolID: enrolled.PoolID, ExpiresAt: enrolled.ExpiresAt,
	}); err != nil {
		return err
	}
	if err := identity.SaveGrantKey(c.StateDir, enrolled.GrantKey); err != nil {
		return err
	}
	if discoveryBuilt {
		if err := identity.SaveDiscoveryKey(c.StateDir, enrolled.DiscoveryKey); err != nil {
			return err
		}
	}
	logger.Info("enrolled", "event", "agent.enrolled", "agent_id", enrolled.AgentID, "expires_at", enrolled.ExpiresAt.Format(time.RFC3339))
	return nil
}

func run(logger *slog.Logger, args []string) error {
	flags := flag.NewFlagSet("run", flag.ExitOnError)
	path := flags.String("config", "agent.json", "configuration file")
	heartbeat := flags.Duration("heartbeat", tunnel.HeartbeatEvery, "heartbeat interval (tests only)")
	renewBefore := flags.Duration("renew-before", 10*24*time.Hour, "renew when the certificate has less than this left (spec 10.7: at 20 of 30 days)")
	updateEvery := flags.Duration("update-every", time.Hour, "how often to ask the cell about updates (spec 10.7: hourly)")
	updateFirst := flags.Duration("update-first", 0, "when to ask first; by default 1 to 5 minutes after starting")
	_ = flags.Parse(args)
	c, err := config.Load(*path)
	if err != nil {
		return err
	}
	// The installed binary launches the agent; the agent is its child.
	launched := os.Getenv(update.ChildEnv) == "1"
	if updatesBuilt && !launched {
		return launch(logger, c.StateDir)
	}
	debug.SetMemoryLimit(int64(c.MemoryLimitMB) << 20)
	// Spec 10.8: no crash dumps, which would write logins in memory to disk.
	_ = login.DisableCoreDumps()
	cert, _, id, err := identity.Load(c.StateDir)
	if err != nil {
		return err
	}
	s, err := settings(c, logger)
	if err != nil {
		return err
	}
	// Writes run only on grants checked with the key the cell sent (spec 10.4).
	grantKey, err := identity.LoadGrantKey(c.StateDir)
	if err != nil {
		return err
	}
	grants, err := grant.NewVerifier(grantKey, id.OrganisationID)
	if err != nil {
		return err
	}
	// The signed actuation allow-lists (spec 47.4), checked with the key grants are.
	allowlists, err := actuation.NewStore(grantKey, id.OrganisationID)
	if err != nil {
		return err
	}
	// Logins the cell keeps (spec 10.7): sealed to this agent's key, for the targets the host allows.
	sealingKeys, err := identity.LoadSealingKeys(c.StateDir)
	if err != nil {
		return err
	}
	logins, err := login.NewOpener(id.AgentID, id.OrganisationID, sealingKeys...)
	if err != nil {
		return err
	}
	targets, err := login.ParseTargets(c.Targets)
	if err != nil {
		return err
	}
	if !login.CanLock() {
		logger.Warn("this host's memory-lock limit is too low: logins the cell passes are held off the heap and wiped, but not locked; raise it (systemd LimitMEMLOCK, docker --ulimit memlock)",
			"event", "agent.logins_unlocked")
	}
	sql := work.NewSQL(c.DSN, grants, logins, targets)
	defer sql.Close()
	webhooks := work.NewHTTP(grants, targets)
	// The MQTT plugin (spec 20.2): brokers on the customer's network, for the targets allowed.
	brokers := work.NewMQTT(logins, targets)
	// The OPC UA plugin (spec 20.3): servers on the customer's network, for the targets allowed.
	servers := work.NewOPCUA(logins, targets)
	// File shares (spec 14.4): read beneath the roots the host's owner allows, and nowhere else.
	files := work.NewFiles(c.FileRoots)
	// SFTP (spec 14.4): servers for the targets allowed, pinned by host key, with logins sealed to this agent.
	sftpServers := work.NewSFTP(logins, targets)
	// Physical writes (spec 47.4): on a grant, to nodes in the current signed allow-list only.
	servers.Grants, servers.Allowlists = grants, allowlists
	brokers.Grants, brokers.Allowlists = grants, allowlists
	webhooks.Allowlists = allowlists
	if c.WebhookCAFile != "" {
		roots, err := webhookRoots(c.WebhookCAFile)
		if err != nil {
			return err
		}
		webhooks.Roots = roots
	}
	s.Heartbeat = *heartbeat
	s.Handlers = map[string]tunnel.Handler{
		"ping": func(_ context.Context, _ json.RawMessage, emit func(any) error) error {
			return emit(protocol.NewPong(Version))
		},
		"sql.read":        sql.Read,
		"sql.transaction": sql.Transaction,
		// Outbound webhooks to private targets (spec 20.4): a post on its grant, a status read without.
		"http.send": webhooks.Send,
		// MQTT reads (spec 20.2): the retained messages on the manifest's topic filters.
		"mqtt.snapshot": brokers.Snapshot,
		// OPC UA reads (spec 20.3): the instances under a root node and their values at the manifest's browse paths.
		"opcua.read":  servers.Read,
		"opcua.probe": servers.Probe,
		// OPC UA setpoint writes (spec 47.1): physical Actions, checked against the signed allow-list here.
		"opcua.write": servers.Write,
		// Commands (spec 47.1): OPC UA method calls and MQTT command publishes, verified by acknowledgement.
		"opcua.call":   servers.Call,
		"mqtt.publish": brokers.Publish,
		// File shares (spec 14.4): a directory's regular files, and one file's bytes in chunks.
		"files.list": files.List,
		"files.read": files.Read,
		// SFTP (spec 14.4): a directory's regular files, and one file's bytes in chunks.
		"sftp.list": sftpServers.List,
		"sftp.read": sftpServers.Read,
	}
	// Discovery (spec 10.5), where this build has it and the host has not switched it off.
	scans, err := newDiscovery(c, id, logger, servers, brokers)
	if err != nil {
		return err
	}
	if scans != nil {
		s.Handlers["discovery.scan"] = scans.handler
	}
	s.DiscoveryDisabled = c.DiscoveryDisabled || !discoveryBuilt
	s.ReplicationDSNs = c.ReplicationDSN
	// The spool (spec 10.6). A queue holding nothing the source no longer has is dropped: the
	// source still holds it for the next reader.
	store, err := spool.Open(filepath.Join(c.StateDir, "spool"), int64(c.SpoolMaxMB)<<20, time.Duration(c.SpoolMaxDays)*24*time.Hour)
	if err != nil {
		return fmt.Errorf("cannot open the spool: %w", err)
	}
	for _, slot := range store.Slots() {
		if q, err := store.Queue(slot); err == nil && !q.Precious() && len(q.Gaps()) == 0 {
			_ = store.Remove(slot)
		}
	}
	s.Spool = store
	// MQTT telemetry (spec 20.6): subscriptions run by the same plugin as MQTT reads.
	s.Telemetry = brokers
	s.Allowlists = allowlists
	s.Monitoring = servers
	client := tunnel.New(s, cert)

	signals, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	ctx, stop := context.WithCancel(signals)
	defer stop()
	if launched {
		update.WatchLauncher(stop)
	}
	listener, err := net.Listen("tcp", c.HealthListen)
	if err != nil {
		return fmt.Errorf("cannot listen on %s for health: %w", c.HealthListen, err)
	}
	health := &http.Server{ReadHeaderTimeout: 5 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "application/json")
		status := http.StatusOK
		state := "connected"
		if !client.Connected() {
			status, state = http.StatusServiceUnavailable, "disconnected"
		}
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]string{"tunnel": state, "agentId": id.AgentID, "version": Version})
	})}
	go func() { _ = health.Serve(listener) }()
	defer health.Close()
	logger.Info("agent started", "event", "agent.started", "agent_id", id.AgentID, "version", Version, "health", listener.Addr().String())
	keys := func(renewed *protocol.EnrolResponse) {
		if err := identity.SaveGrantKey(c.StateDir, renewed.GrantKey); err == nil {
			_ = grants.Use(renewed.GrantKey)
			_ = allowlists.Use(renewed.GrantKey)
		}
		if scans != nil {
			scans.useKey(c, renewed.DiscoveryKey)
		}
	}
	go renewals(ctx, logger, c, client, id, keys, logins, *renewBefore)
	// Updates through Fleet (spec 10.7), checked by this binary with the release keys built into it.
	var restarting atomic.Bool
	if updatesBuilt {
		releaseKeys, err := update.ParseKeys(ReleaseKeys)
		if err != nil {
			logger.Error("the release keys built in do not parse; no update is taken", "event", "agent.release_keys_invalid")
		}
		sovereignKeys, err := update.ParseKeys(SovereignKeys)
		if err != nil {
			logger.Error("the sovereign keys built in do not parse; no update is taken", "event", "agent.release_keys_invalid")
		}
		first := *updateFirst
		if first == 0 {
			first = time.Minute + time.Duration(rand.Int64N(int64(4*time.Minute)))
		}
		base := os.Getenv(update.BaseVersionEnv)
		if base == "" {
			base = Version
		}
		u := &updater{logger: logger, stateDir: c.StateDir, client: client, keys: releaseKeys, sovereignKeys: sovereignKeys, base: base, restart: func() {
			// Work in hand finishes first, for a minute at most; then the agent stops for its launcher.
			go func() {
				for deadline := time.Now().Add(time.Minute); client.Active() > 0 && time.Now().Before(deadline); {
					time.Sleep(100 * time.Millisecond)
				}
				restarting.Store(true)
				stop()
			}()
		}}
		go u.run(ctx, first, *updateEvery)
	}
	err = client.Run(ctx)
	if restarting.Load() {
		store.Sync()
		return errRestart
	}
	return err
}

// renewals checks the certificate at start and hourly, and renews it with a new key once it
// has less than renewBefore left (spec 10.7: "Valid 30 days, renewed at 20 with a new local key
// pair"). A failure is logged and tried at the next check; the certificate stays valid meanwhile.
func renewals(ctx context.Context, logger *slog.Logger, c *config.Config, client *tunnel.Client, id identity.Identity, keys func(*protocol.EnrolResponse),
	logins *login.Opener, renewBefore time.Duration) {
	check := func() {
		cert, _, current, err := identity.Load(c.StateDir)
		if err != nil {
			logger.Error("cannot read the certificate to check it", "event", "agent.renewal_failed")
			return
		}
		leaf, err := x509.ParseCertificate(cert.Certificate[0])
		if err != nil || time.Until(leaf.NotAfter) > renewBefore {
			return
		}
		csr, key, err := identity.NewRequest(c.StateDir, c.Name)
		if err != nil {
			logger.Error("cannot make a new key", "event", "agent.renewal_failed")
			return
		}
		// A new sealing key with the new certificate: the cell seals logins to it from now on.
		sealingKey, err := identity.NewSealingKey(c.StateDir)
		if err != nil {
			logger.Error("cannot make a new sealing key", "event", "agent.renewal_failed")
			return
		}
		rctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		defer cancel()
		renewed, err := client.Renew(rctx, csr, sealingKey)
		if err != nil {
			logger.Warn(err.Error(), "event", "agent.renewal_failed")
			return
		}
		if err := identity.TakeSealingKey(c.StateDir); err == nil {
			if raw, err := identity.LoadSealingKeys(c.StateDir); err == nil {
				_ = logins.Use(raw...)
			}
		}
		current.ExpiresAt = renewed.ExpiresAt
		if err := identity.Save(c.StateDir, key, renewed.Certificate, renewed.CACertificate, current); err != nil {
			logger.Error(err.Error(), "event", "agent.renewal_failed")
			return
		}
		// The keys the cell's instructions are checked against may have changed with it.
		keys(renewed)
		next, _, _, err := identity.Load(c.StateDir)
		if err != nil {
			logger.Error(err.Error(), "event", "agent.renewal_failed")
			return
		}
		client.Renewed(next)
		logger.Info("certificate renewed", "event", "agent.certificate_renewed", "agent_id", id.AgentID, "expires_at", renewed.ExpiresAt.Format(time.RFC3339))
	}
	check()
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			check()
		}
	}
}

// webhookRoots is the system's roots with a customer's own CA added, for private webhook targets.
func webhookRoots(path string) (*x509.CertPool, error) {
	pool, err := x509.SystemCertPool()
	if err != nil || pool == nil {
		pool = x509.NewCertPool()
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("cannot read the webhook CA file: %w", err)
	}
	if !pool.AppendCertsFromPEM(raw) {
		return nil, fmt.Errorf("%s holds no certificate", path)
	}
	return pool, nil
}
