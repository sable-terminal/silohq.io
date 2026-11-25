package discovery

import (
	"context"
	"encoding/binary"
	"errors"
	"net"
	"regexp"
	"strings"
)

var hostname = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$`)

// Targets are an authorisation's explicit targets, as the cell reads them: IPv4 addresses,
// IPv4 ranges of /16 or narrower, and host names, nothing implied.
type Targets struct {
	names map[string]bool
	ips   map[string]bool
	nets  []*net.IPNet
	// order is the targets as given, for enumeration.
	order []string
}

// ParseTargets reads targets, refusing any the cell would not have authorised.
func ParseTargets(ranges []string) (*Targets, error) {
	t := &Targets{names: map[string]bool{}, ips: map[string]bool{}}
	for _, raw := range ranges {
		r := strings.ToLower(strings.TrimSpace(raw))
		switch {
		case strings.Contains(r, "/"):
			ip, network, err := net.ParseCIDR(r)
			if err != nil || ip.To4() == nil {
				return nil, errors.New("a range is IPv4, /16 or narrower: " + r)
			}
			if ones, _ := network.Mask.Size(); ones < 16 {
				return nil, errors.New("a range is IPv4, /16 or narrower: " + r)
			}
			t.nets = append(t.nets, network)
		case net.ParseIP(r) != nil:
			if net.ParseIP(r).To4() == nil {
				return nil, errors.New("an address is IPv4: " + r)
			}
			t.ips[net.ParseIP(r).To4().String()] = true
		case len(r) <= 253 && hostname.MatchString(r) && strings.Trim(r, "0123456789.") != "":
			t.names[r] = true
		default:
			return nil, errors.New("not a target: " + r)
		}
		t.order = append(t.order, r)
	}
	if len(t.order) == 0 {
		return nil, errors.New("no targets")
	}
	return t, nil
}

// Contains says whether a host is one of the targets exactly as the cell checks it: a name
// listed, or an IPv4 address listed or within a range.
func (t *Targets) Contains(host string) bool {
	h := strings.ToLower(strings.TrimSpace(host))
	if t.names[h] {
		return true
	}
	ip := net.ParseIP(h).To4()
	if ip == nil {
		return false
	}
	if t.ips[ip.String()] {
		return true
	}
	for _, n := range t.nets {
		if n.Contains(ip) {
			return true
		}
	}
	return false
}

// Resolver finds a name's addresses.
type Resolver func(ctx context.Context, host string) ([]net.IP, error)

// Match is how a system the agent found would be reported, if it may be: the host as listed,
// or a name not listed resolved to an address within the targets. Nothing outside them.
func (t *Targets) Match(ctx context.Context, host string, resolve Resolver) (string, bool) {
	h := strings.ToLower(strings.TrimSpace(host))
	if h == "" {
		return "", false
	}
	if t.Contains(h) {
		if ip := net.ParseIP(h).To4(); ip != nil {
			return ip.String(), true
		}
		return h, true
	}
	if net.ParseIP(h) != nil || resolve == nil || (len(t.ips) == 0 && len(t.nets) == 0) {
		return "", false
	}
	ips, err := resolve(ctx, h)
	if err != nil {
		return "", false
	}
	for _, ip := range ips {
		if v4 := ip.To4(); v4 != nil && t.Contains(v4.String()) {
			return v4.String(), true
		}
	}
	return "", false
}

// Each gives every host the targets name, in order: names and addresses as listed, then each
// address of a range (without a range's network and broadcast addresses, narrower than /31),
// until fn says stop or ctx ends. A host appears once.
func (t *Targets) Each(ctx context.Context, fn func(host string) bool) {
	seen := map[string]bool{}
	give := func(h string) bool {
		if seen[h] {
			return true
		}
		seen[h] = true
		return ctx.Err() == nil && fn(h)
	}
	for _, r := range t.order {
		if !strings.Contains(r, "/") {
			h := r
			if ip := net.ParseIP(r).To4(); ip != nil {
				h = ip.String()
			}
			if !give(h) {
				return
			}
			continue
		}
		_, network, _ := net.ParseCIDR(r)
		ones, bits := network.Mask.Size()
		first := binary.BigEndian.Uint32(network.IP.To4())
		size := uint32(1) << uint(bits-ones)
		start, end := first, first+size-1
		if size > 2 {
			start, end = first+1, end-1
		}
		for n := start; ; n++ {
			ip := make(net.IP, 4)
			binary.BigEndian.PutUint32(ip, n)
			if !give(ip.String()) {
				return
			}
			if n == end {
				break
			}
		}
	}
}
