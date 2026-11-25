package login

import (
	"os"
	"sync/atomic"

	"github.com/awnumar/memcall"
)

// Secret is a password held outside Go's heap for the length of one call (spec 10.7): its own
// mapped pages, which the garbage collector never moves or copies, locked into memory so they
// are never swapped to disk where the host allows it (and kept out of core dumps), and wiped
// and unmapped when the call ends.
//
// It uses memcall, memguard's own memory layer, rather than memguard's LockedBuffer: a lock
// memguard cannot take panics the whole process and wipes every other buffer first, and a
// container's memory-lock limit (often 64 KB) makes that likely under load. Here a lock that
// cannot be taken leaves the password unlocked but still off the heap and wiped after, and the
// agent says so once.
type Secret struct {
	b      []byte
	region []byte
	locked bool
}

var unlockedNoted atomic.Bool

// Unlocked says whether a password has had to be held without a memory lock; the agent logs it once.
func Unlocked() bool { return unlockedNoted.Load() }

// newSecret maps room for up to n bytes. The caller fills Bytes and trims it with keep.
func newSecret(n int) (*Secret, error) {
	if n == 0 {
		return &Secret{}, nil
	}
	page := os.Getpagesize()
	region, err := memcall.Alloc((n + page - 1) / page * page)
	if err != nil {
		return nil, err
	}
	s := &Secret{b: region[:n], region: region}
	if memcall.Lock(region) == nil {
		s.locked = true
	} else {
		unlockedNoted.Store(true)
	}
	return s, nil
}

// keep trims the secret to its first n bytes; the rest of its pages stay wiped.
func (s *Secret) keep(n int) {
	clear(s.b[n:])
	s.b = s.b[:n]
}

// Bytes is the password, valid until Destroy.
func (s *Secret) Bytes() []byte {
	if s == nil {
		return nil
	}
	return s.b
}

// Locked says whether the pages are locked into memory.
func (s *Secret) Locked() bool { return s != nil && s.locked }

// Destroy wipes the password and returns its pages. Safe to call twice.
func (s *Secret) Destroy() {
	if s == nil || s.region == nil {
		return
	}
	clear(s.region)
	if s.locked {
		_ = memcall.Unlock(s.region)
	}
	_ = memcall.Free(s.region)
	s.b, s.region, s.locked = nil, nil, false
}

// CanLock says whether this host lets the agent lock a password's pages into memory.
func CanLock() bool {
	s, err := newSecret(1)
	if err != nil {
		return false
	}
	locked := s.Locked()
	s.Destroy()
	return locked
}

// DisableCoreDumps keeps a crash from writing the process's memory to disk (spec 10.8: "Crash
// dumps are disabled"), where the host allows it.
func DisableCoreDumps() error { return memcall.DisableCoreDumps() }
