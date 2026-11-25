package login

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"regexp"
	"strings"
)

// Targets are the systems the host's owner lets the cell send this agent to (configuration
// `targets`): host names, *.suffix wildcards, addresses and networks. A login the cell keeps
// names its database's address, so without this a cell could point the agent anywhere on the
// customer's network; a scan of it needs a signed, approved authorisation (spec 19), and so must
// any reach. A connection the agent holds the login for names its own address, and needs none.
type Targets struct {
	names    map[string]bool
	suffixes []string
	networks []netip.Prefix
}

var hostname = regexp.MustCompile(`^(?i)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$`)

// ParseTargets reads the configuration's list.
func ParseTargets(list []string) (Targets, error) {
	t := Targets{names: map[string]bool{}}
	for _, entry := range list {
		entry = strings.ToLower(strings.TrimSpace(entry))
		switch {
		case strings.HasPrefix(entry, "*."):
			if !hostname.MatchString(entry[2:]) {
				return Targets{}, errors.New("a target wildcard is *. and a host name")
			}
			t.suffixes = append(t.suffixes, entry[1:])
		case strings.Contains(entry, "/"):
			prefix, err := netip.ParsePrefix(entry)
			if err != nil {
				return Targets{}, errors.New("a target network is an address and a prefix length")
			}
			t.networks = append(t.networks, prefix.Masked())
		default:
			if addr, err := netip.ParseAddr(entry); err == nil {
				t.networks = append(t.networks, netip.PrefixFrom(addr.Unmap(), addr.Unmap().BitLen()))
			} else if hostname.MatchString(entry) {
				t.names[entry] = true
			} else {
				return Targets{}, errors.New("a target is a host name, *.name, an address or a network")
			}
		}
	}
	return t, nil
}

// Empty says whether no target is allowed.
func (t Targets) Empty() bool {
	return len(t.names) == 0 && len(t.suffixes) == 0 && len(t.networks) == 0
}

func (t Targets) inNetworks(addr netip.Addr) bool {
	addr = addr.Unmap()
	for _, network := range t.networks {
		if network.Contains(addr) {
			return true
		}
	}
	return false
}

// Allow says whether the agent may connect to host, and where: a host allowed by its name is
// reached by name (nil addresses); any other must resolve wholly inside the allowed networks,
// and is reached at those addresses only, so the name cannot point elsewhere afterwards.
func (t Targets) Allow(ctx context.Context, host string, resolve func(context.Context, string) ([]netip.Addr, error)) ([]string, bool) {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if addr, err := netip.ParseAddr(host); err == nil {
		return []string{addr.String()}, t.inNetworks(addr)
	}
	if !hostname.MatchString(host) {
		return nil, false
	}
	if t.names[host] {
		return nil, true
	}
	for _, suffix := range t.suffixes {
		if strings.HasSuffix(host, suffix) {
			return nil, true
		}
	}
	if len(t.networks) == 0 {
		return nil, false
	}
	if resolve == nil {
		resolve = func(ctx context.Context, host string) ([]netip.Addr, error) {
			return net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		}
	}
	addrs, err := resolve(ctx, host)
	if err != nil || len(addrs) == 0 {
		return nil, false
	}
	out := make([]string, 0, len(addrs))
	for _, addr := range addrs {
		if !t.inNetworks(addr) {
			return nil, false
		}
		out = append(out, addr.Unmap().String())
	}
	return out, true
}
