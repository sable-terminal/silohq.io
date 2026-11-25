// Package update is how the agent updates itself through Fleet (spec 10.7, 11.4): it asks the
// cell hourly what to do, checks an offered release itself, downloads its binary over the
// tunnel's mutual TLS, keeps it beside the one it ran before, and restarts onto it.
//
// The agent trusts no cell for what it runs. The Silo release keys are built into the binary
// (-ldflags -X main.ReleaseKeys), and an offered release is taken only when:
//   - the channel head and the release manifest each carry a valid signature by one of those
//     keys, over "silo.channel.v1" or "silo.release.v1", a NUL and the canonical JSON text
//     exactly as it arrived (a signature by a known key that does not verify refuses it outright);
//   - the head is on this build's agent channel and names this manifest, by release id and by
//     the SHA-256 of its text, so a release registered but never promoted is refused;
//   - the manifest is for this build target, and names a binary for this platform with the
//     version and digest offered;
//   - the version is later than the one running, and not one that failed here before;
//   - the downloaded bytes hash to the digest.
//
// Going back is only ever to the binary kept from before, never to a download.
package update

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"

	"silohq.io/agent/internal/signing"
)

// The signed documents' purposes, as fleet-control signs them.
const (
	ReleasePrefix = "silo.release.v1"
	ChannelPrefix = "silo.channel.v1"
)

// MaxBinaryBytes is the largest binary taken.
const MaxBinaryBytes = 256 << 20

// Refusals, as the cell's report schema names them.
const (
	RefusedSignature    = "signature"
	RefusedNotPromoted  = "not_promoted"
	RefusedTarget       = "target"
	RefusedPlatform     = "platform"
	RefusedDigest       = "digest"
	RefusedFailedStart  = "failed_to_start"
	RefusedNotNewer     = "not_newer"
	RefusedFailedBefore = "failed_before"
	RefusedStorage      = "storage"
	RefusedNoKey        = "no_release_key"
	RefusedNoPrevious   = "no_previous"
)

// Keys are the Silo release keys built into the agent, by key id.
type Keys map[string]ed25519.PublicKey

// ParseKeys reads a comma-separated list of base64 SubjectPublicKeyInfo DER Ed25519 keys.
func ParseKeys(list string) (Keys, error) {
	keys := Keys{}
	for _, item := range strings.Split(list, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		der, err := base64.StdEncoding.DecodeString(item)
		if err != nil {
			return nil, errors.New("a release key is not base64")
		}
		parsed, err := x509.ParsePKIXPublicKey(der)
		if err != nil {
			return nil, errors.New("a release key does not parse")
		}
		key, ok := parsed.(ed25519.PublicKey)
		if !ok {
			return nil, errors.New("a release key is not Ed25519")
		}
		sum := sha256.Sum256(der)
		keys[base64.RawURLEncoding.EncodeToString(sum[:])] = key
	}
	return keys, nil
}

// Signature is one signature record on a signed document.
type Signature struct {
	KeyID     string `json:"keyId"`
	Role      string `json:"role"`
	Signature string `json:"signature"`
}

// Signed is a document's canonical JSON text, exactly as signed, and its signatures.
type Signed struct {
	Text       string      `json:"text"`
	Signatures []Signature `json:"signatures"`
}

// Offer is the cell's answer to GET /v1/update.
type Offer struct {
	Action   string `json:"action"` // none, update or rollback
	Version  string `json:"version,omitempty"`
	Platform string `json:"platform,omitempty"`
	Digest   string `json:"digest,omitempty"`
	Bytes    int64  `json:"bytes,omitempty"`
	Head     Signed `json:"head"`
	Release  Signed `json:"release"`
}

// Report is what the agent tells the cell of an update it refused or undid.
type Report struct {
	Version string `json:"version"`
	Outcome string `json:"outcome"` // refused or undone
	Reason  string `json:"reason"`
}

// Want is what this agent will take.
type Want struct {
	Channel string // agent-stable, or agent-sovereign for the sovereign build
	Target  string // commercial, or sovereign
	// SovereignKeys are the sovereign release keys a sovereign build trusts: an agent-sovereign
	// head is the sovereign fleet-control's, promoted once UK cleared staff countersigned the
	// bundle that brought the release in (spec 11.1, 11.4), so it must carry one's signature.
	SovereignKeys Keys
	Platform      string
	Running       string
	Failed        []string
}

type head struct {
	Schema         string `json:"schema"`
	Channel        string `json:"channel"`
	ReleaseID      string `json:"releaseId"`
	ManifestDigest string `json:"manifestDigest"`
}

type manifest struct {
	Schema        string `json:"schema"`
	ReleaseID     string `json:"releaseId"`
	Target        string `json:"target"`
	AgentBinaries []struct {
		Platform string `json:"platform"`
		Version  string `json:"version"`
		Digest   string `json:"digest"`
	} `json:"agentBinaries"`
}

// verified says whether a document carries a valid signature by a key of the role; a signature
// by a known key that does not verify means tampering, and refuses it whatever else it carries.
func verified(keys Keys, role, prefix string, doc Signed) bool {
	ok := false
	for _, s := range doc.Signatures {
		key, known := keys[s.KeyID]
		if !known || s.Role != role {
			continue
		}
		if !signing.Verify(key, prefix, doc.Text, s.Signature) {
			return false
		}
		ok = true
	}
	return ok
}

// Check decides whether to take an offered update. It returns "" to take it, or the refusal.
func Check(o Offer, keys Keys, want Want) string {
	if len(keys) == 0 {
		return RefusedNoKey
	}
	// The release is always Silo's; the head on agent-sovereign is the sovereign fleet-control's.
	headKeys, headRole := keys, "release"
	if want.Channel == "agent-sovereign" {
		if len(want.SovereignKeys) == 0 {
			return RefusedNoKey
		}
		headKeys, headRole = want.SovereignKeys, "sovereign"
	}
	if !verified(headKeys, headRole, ChannelPrefix, o.Head) || !verified(keys, "release", ReleasePrefix, o.Release) {
		return RefusedSignature
	}
	var h head
	var m manifest
	if json.Unmarshal([]byte(o.Head.Text), &h) != nil || json.Unmarshal([]byte(o.Release.Text), &m) != nil {
		return RefusedSignature
	}
	sum := sha256.Sum256([]byte(o.Release.Text))
	if h.Schema != ChannelPrefix || m.Schema != ReleasePrefix || h.Channel != want.Channel || h.ReleaseID != m.ReleaseID ||
		h.ManifestDigest != "sha256:"+hex.EncodeToString(sum[:]) {
		return RefusedNotPromoted
	}
	if m.Target != want.Target {
		return RefusedTarget
	}
	found := false
	for _, b := range m.AgentBinaries {
		if b.Platform == want.Platform && o.Platform == want.Platform && b.Version == o.Version && b.Digest == o.Digest {
			found = true
		}
	}
	if !found {
		return RefusedPlatform
	}
	if Compare(o.Version, want.Running) <= 0 {
		return RefusedNotNewer
	}
	if slices.Contains(want.Failed, o.Version) {
		return RefusedFailedBefore
	}
	if o.Bytes <= 0 || o.Bytes > MaxBinaryBytes {
		return RefusedDigest
	}
	return ""
}

// Compare orders two semantic versions: negative, zero or positive. A pre-release is before
// its release; build metadata is ignored.
func Compare(a, b string) int {
	core := func(v string) ([3]int, string) {
		v, _, _ = strings.Cut(v, "+")
		v, pre, _ := strings.Cut(v, "-")
		var n [3]int
		for i, p := range strings.SplitN(v, ".", 3) {
			n[i], _ = strconv.Atoi(p)
		}
		return n, pre
	}
	x, xp := core(a)
	y, yp := core(b)
	for i := range x {
		if x[i] != y[i] {
			return x[i] - y[i]
		}
	}
	switch {
	case xp == yp:
		return 0
	case xp == "":
		return 1
	case yp == "":
		return -1
	}
	xs, ys := strings.Split(xp, "."), strings.Split(yp, ".")
	for i := 0; i < len(xs) && i < len(ys); i++ {
		xn, xerr := strconv.Atoi(xs[i])
		yn, yerr := strconv.Atoi(ys[i])
		switch {
		case xerr == nil && yerr == nil && xn != yn:
			return xn - yn
		case xerr == nil && yerr != nil:
			return -1
		case xerr != nil && yerr == nil:
			return 1
		case xs[i] != ys[i]:
			return strings.Compare(xs[i], ys[i])
		}
	}
	return len(xs) - len(ys)
}

// Entry is a binary kept under stateDir/bin.
type Entry struct {
	Version string `json:"version"`
	Digest  string `json:"digest"`
	File    string `json:"file"`
}

// State is stateDir/bin/state.json: the binary to run (none: the one installed), the one run
// before it, versions that failed here, and reports not yet delivered.
type State struct {
	Current  *Entry   `json:"current,omitempty"`
	Previous *Entry   `json:"previous,omitempty"`
	Failed   []string `json:"failed,omitempty"`
	Pending  []Report `json:"pending,omitempty"`
}

func binDir(stateDir string) string { return filepath.Join(stateDir, "bin") }

// FileName is a version's binary's name.
func FileName(version string) string {
	name := "silo-agent-" + version
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	return name
}

// Path is where an entry's binary is.
func Path(stateDir string, e *Entry) string { return filepath.Join(binDir(stateDir), e.File) }

// Load reads the state; none yet is an empty state.
func Load(stateDir string) (State, error) {
	var s State
	raw, err := os.ReadFile(filepath.Join(binDir(stateDir), "state.json"))
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return s, err
	}
	if err := json.Unmarshal(raw, &s); err != nil {
		return State{}, fmt.Errorf("the update state does not parse: %w", err)
	}
	return s, nil
}

// Save writes the state whole, so a crash leaves the old one or the new.
func Save(stateDir string, s State) error {
	dir := binDir(stateDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	raw, _ := json.MarshalIndent(s, "", "  ")
	tmp := filepath.Join(dir, "state.json.tmp")
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(raw); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(dir, "state.json"))
}

// Intact says whether an entry's binary is there with the bytes it was taken with.
func Intact(stateDir string, e *Entry) bool {
	f, err := os.Open(Path(stateDir, e))
	if err != nil {
		return false
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return false
	}
	return "sha256:"+hex.EncodeToString(h.Sum(nil)) == e.Digest
}

// Receive writes a binary as it downloads, hashing it, and keeps it only if it is exactly the
// bytes offered. The binary is executable by the agent's user alone.
func Receive(stateDir string, o Offer, body io.Reader) (*Entry, error) {
	dir := binDir(stateDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, errStorage{err}
	}
	name := FileName(o.Version)
	part := filepath.Join(dir, name+".part")
	f, err := os.OpenFile(part, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o700)
	if err != nil {
		return nil, errStorage{err}
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(body, o.Bytes+1))
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(part)
		return nil, err
	}
	if n != o.Bytes || "sha256:"+hex.EncodeToString(h.Sum(nil)) != o.Digest {
		os.Remove(part)
		return nil, ErrDigest
	}
	if err := os.Rename(part, filepath.Join(dir, name)); err != nil {
		os.Remove(part)
		return nil, errStorage{err}
	}
	return &Entry{Version: o.Version, Digest: o.Digest, File: name}, nil
}

// ErrDigest: the bytes downloaded are not the binary offered.
var ErrDigest = errors.New("the binary downloaded does not match its digest")

type errStorage struct{ error }

// IsStorage says whether the host could not keep the binary.
func IsStorage(err error) bool {
	var s errStorage
	return errors.As(err, &s)
}

// Take makes a received binary the one to run, keeping the one running now as the one before.
func (s *State) Take(e *Entry) {
	s.Previous = s.Current
	s.Current = e
}

// Back returns to the binary run before (none: the installed one), marking the current one as
// failed here. False when there is nothing to go back to.
func (s *State) Back(reason string) bool {
	if s.Current == nil {
		return false
	}
	if !slices.Contains(s.Failed, s.Current.Version) {
		s.Failed = append(s.Failed, s.Current.Version)
	}
	if reason != "" {
		s.Pending = append(s.Pending, Report{Version: s.Current.Version, Outcome: "undone", Reason: reason})
	}
	s.Current, s.Previous = s.Previous, nil
	return true
}

// Prune removes binaries the state no longer names.
func Prune(stateDir string, s State) {
	keep := map[string]bool{}
	for _, e := range []*Entry{s.Current, s.Previous} {
		if e != nil {
			keep[e.File] = true
		}
	}
	entries, _ := os.ReadDir(binDir(stateDir))
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "silo-agent-") && !keep[entry.Name()] {
			os.Remove(filepath.Join(binDir(stateDir), entry.Name()))
		}
	}
}
