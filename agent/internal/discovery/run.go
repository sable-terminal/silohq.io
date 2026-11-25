package discovery

import (
	"context"
	"errors"
	"log/slog"

	"net"
	"silohq.io/agent/internal/protocol"
	"slices"
	"strconv"
	"sync"
	"syscall"
	"time"
)

// DefaultPorts are the ports a port scan tries: where the systems Silo connects to listen.
// The host's own configuration may name others (discoveryPorts); the cell cannot.
var DefaultPorts = []int{
	21, 22, 80, 443, 445, // FTP, SSH/SFTP, HTTP(S), SMB
	1433, 1521, 3306, 5432, 50000, // SQL Server, Oracle, MySQL, Postgres, Db2
	1883, 8883, 4840, 5672, 9092, // MQTT, OPC UA, AMQP, Kafka
	6379, 9200, 27017, 5984, // Redis, Elasticsearch, MongoDB, CouchDB
	8080, 8443, 8000, 9000, // HTTP alternatives
}

// Spec 19.3's targets.
const (
	HostsPerSecond = 50
	ConnsPerHost   = 2
	// maxHostsAtOnce bounds sockets: hosts in flight at once, each with ConnsPerHost.
	maxHostsAtOnce = 64
)

// Settings are the host's: what it lets discovery use.
type Settings struct {
	// Ports a port scan tries; DefaultPorts when empty.
	Ports []int
	// ConfigPaths are further files host configuration reads, as the host names them.
	ConfigPaths []string
	// Databases are the connections this agent holds credentials for, by id: the only
	// catalogues introspection opens ("where credentials already exist").
	Databases func() map[string]string
	// Endpoints are the industrial endpoints the cell sent with the scan, their logins and keys
	// sealed for it: the only servers and brokers browsed or observed. Industrial runs the plugins.
	Endpoints  []protocol.DiscoveryEndpoint
	Industrial Industrial
	Resolve    Resolver
	Logger     *slog.Logger
	// DialTimeout bounds one connection attempt.
	DialTimeout time.Duration
	// HostsPerSecond overrides the rate (tests may only lower it).
	HostsPerSecond int
	now            func() time.Time
}

// Run carries out an authorised scan, reporting as it goes, and ends it. It returns an error
// only when the report cannot be sent (the cell has gone).
func Run(ctx context.Context, s Settings, a Authorisation, emit func(frame any) error) error {
	targets, err := ParseTargets(a.Ranges)
	if err != nil {
		return emit(End{Type: "end", Status: "failed", Reason: "authorisation"})
	}
	if s.now == nil {
		s.now = time.Now
	}
	if len(s.Ports) == 0 {
		s.Ports = DefaultPorts
	}
	if s.DialTimeout == 0 {
		s.DialTimeout = 2 * time.Second
	}
	if s.Resolve == nil {
		s.Resolve = func(ctx context.Context, host string) ([]net.IP, error) {
			return net.DefaultResolver.LookupIP(ctx, "ip4", host)
		}
	}
	if s.Logger == nil {
		s.Logger = slog.New(slog.DiscardHandler)
	}
	rate := HostsPerSecond
	if s.HostsPerSecond > 0 && s.HostsPerSecond < rate {
		rate = s.HostsPerSecond
	}
	ctx, cancel := context.WithDeadline(ctx, a.ExpiresAt)
	defer cancel()
	r := &run{settings: s, targets: targets, bound: newBound(a.MaxHosts), emit: emit, ctx: ctx, pace: newPace(ctx, rate)}

	var unavailable []string
	// Industrial endpoints first, while the logins and keys sealed for the scan are fresh; then
	// local files, catalogues the agent already holds credentials for, and the network.
	for _, method := range []string{MethodOPCUA, MethodMQTT, MethodHostConfig, MethodCatalogue, MethodPortScan} {
		if !slices.Contains(a.Methods, method) {
			continue
		}
		switch method {
		case MethodHostConfig:
			r.hostConfig()
		case MethodCatalogue:
			r.catalogues()
		case MethodPortScan:
			r.portScan()
		case MethodOPCUA, MethodMQTT:
			if r.settings.Industrial == nil {
				unavailable = append(unavailable, method)
				continue
			}
			r.industrial(method)
		}
		if r.failed() != nil {
			break
		}
	}
	if err := r.failed(); err != nil {
		return err
	}
	end := End{Type: "end", Status: "completed", Unavailable: unavailable}
	switch {
	case !s.now().Before(a.ExpiresAt):
		end.Status, end.Reason = "failed", "authorisation_expired"
	case ctx.Err() != nil:
		// The cell stopped it, or its deadline passed: there is no one to tell.
		return ctx.Err()
	case r.bound.reached():
		end.Reason = "max_hosts"
	}
	return emit(end)
}

type run struct {
	settings Settings
	targets  *Targets
	bound    *bound
	ctx      context.Context
	pace     <-chan struct{}
	emitMu   sync.Mutex
	emit     func(frame any) error
	errMu    sync.Mutex
	err      error
}

// send reports one frame; the first failure to send stops the scan.
func (r *run) send(frame any) bool {
	r.emitMu.Lock()
	defer r.emitMu.Unlock()
	if r.failed() != nil {
		return false
	}
	if err := r.emit(frame); err != nil {
		r.errMu.Lock()
		r.err = err
		r.errMu.Unlock()
		return false
	}
	return true
}

func (r *run) failed() error {
	r.errMu.Lock()
	defer r.errMu.Unlock()
	return r.err
}

func (r *run) going() bool { return r.ctx.Err() == nil && r.failed() == nil }

func (r *run) probe(host string, port int, method, outcome string) bool {
	p := Probe{Type: "probe", Host: host, Method: method, Outcome: outcome, ProbedAt: r.settings.now().UTC()}
	if port > 0 {
		p.Port = intp(port)
	}
	return r.send(p)
}

func (r *run) finding(host, method string, found Found) bool {
	return r.send(Finding{Type: "finding", Host: host, Method: method, Found: found})
}

// portScan contacts each target host, at most HostsPerSecond new hosts a second and
// maxHostsAtOnce at once, each on at most ConnsPerHost connections, until the bound.
func (r *run) portScan() {
	hosts := make(chan struct{}, maxHostsAtOnce)
	var wg sync.WaitGroup
	r.targets.Each(r.ctx, func(host string) bool {
		if !r.bound.admit(host) {
			return false
		}
		select {
		case <-r.ctx.Done():
			return false
		case <-r.pace:
		}
		select {
		case <-r.ctx.Done():
			return false
		case hosts <- struct{}{}:
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-hosts }()
			r.scanHost(host)
		}()
		return r.going()
	})
	wg.Wait()
}

func (r *run) scanHost(host string) {
	conns := make(chan struct{}, ConnsPerHost)
	var wg sync.WaitGroup
	for _, port := range r.settings.Ports {
		if !r.going() {
			break
		}
		conns <- struct{}{}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-conns }()
			outcome, found, ok := r.tryPort(host, port)
			if !ok {
				return
			}
			if r.probe(host, port, MethodPortScan, outcome) && (outcome == Open || outcome == Identified) {
				r.finding(host, MethodPortScan, found)
			}
		}()
	}
	wg.Wait()
}

// tryPort connects once, and identifies what answered; ok false when the scan was stopped
// before it could tell.
func (r *run) tryPort(host string, port int) (string, Found, bool) {
	dialer := net.Dialer{Timeout: r.settings.DialTimeout}
	conn, err := dialer.DialContext(r.ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		if r.ctx.Err() != nil {
			return "", Found{}, false
		}
		var netErr net.Error
		switch {
		case errors.Is(err, syscall.ECONNREFUSED), errors.As(err, &netErr) && netErr.Timeout():
			return Closed, Found{}, true
		default:
			return Error, Found{}, true
		}
	}
	defer conn.Close()
	if found, ok := identify(conn, host, port); ok {
		return Identified, found, true
	}
	return Open, service(port, "", "", "other", ""), true
}

// bound holds the authorisation's host bound: distinct hosts contacted or reported.
type bound struct {
	mu   sync.Mutex
	seen map[string]bool
	max  int
	full bool
}

func newBound(max int) *bound { return &bound{seen: map[string]bool{}, max: max} }

// admit says whether a host may be contacted or reported: one already counted, or a new one
// within the bound.
func (b *bound) admit(host string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.seen[host] {
		return true
	}
	if len(b.seen) >= b.max {
		b.full = true
		return false
	}
	b.seen[host] = true
	return true
}

func (b *bound) reached() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.full
}

// newPace gives one token every 1/perSecond, holding at most one: never a burst.
func newPace(ctx context.Context, perSecond int) <-chan struct{} {
	tokens := make(chan struct{}, 1)
	tokens <- struct{}{}
	go func() {
		ticker := time.NewTicker(time.Second / time.Duration(perSecond))
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				select {
				case tokens <- struct{}{}:
				default:
				}
			}
		}
	}()
	return tokens
}
