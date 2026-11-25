// Package actuation holds the signed actuation allow-lists on this host (spec 47.4: "The
// allow-list is signed by the control plane. The agent refuses any write to a node absent from
// its current signed list, independently of the cell, so a compromised cell cannot write to an
// unlisted node").
//
// The cell sends a connection's whole list as the entries' canonical texts with their Ed25519
// signatures, and sends it again whenever the digest this agent reports in its heartbeat is not
// the current one's. Every entry must verify with the key the cell gave this agent at enrolment
// (or renewal, the key execution grants are checked with), name this agent's organisation and
// that connection, and read as an entry; otherwise the list is refused whole and the one held
// stays. An empty list ends the connection's. Writes look entries up here (package work).
//
// An OPC UA method's entry may bound its input arguments (D245): each by name and built-in type,
// in the method's order, a number with its least and greatest value, text with the values it may
// take, a Boolean either way. An entry whose arguments do not read so is refused as any other.
package actuation

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math/big"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"silohq.io/agent/internal/protocol"
	"silohq.io/agent/internal/signing"
)

// Prefix is what an entry's signature covers before its text.
const Prefix = "silo.actuation_allowlist.v1"

const (
	maxEntries     = 500
	maxConnections = 1_000
)

// Refusals, as the agent logs them.
const (
	RefusedNoKey     = "no_key"
	RefusedKey       = "key"
	RefusedSignature = "signature"
	RefusedEntry     = "entry"
	RefusedBound     = "bound"
)

var (
	uuidPattern    = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	decimalPattern = regexp.MustCompile(`^-?\d{1,18}(\.\d{1,12})?$`)
)

// ArgumentTypes are the OPC UA built-in types a method's input argument may take, by name, and
// each one's identifier in namespace 0 (the DataType an Argument names).
var ArgumentTypes = map[string]uint32{
	"Boolean": 1, "SByte": 2, "Byte": 3, "Int16": 4, "UInt16": 5, "Int32": 6, "UInt32": 7, "Int64": 8, "Float": 10, "Double": 11, "String": 12,
}

// Argument bounds one input argument of a method (D245).
type Argument struct {
	Name     string   `json:"name"`
	DataType string   `json:"data_type"`
	MinValue *string  `json:"min_value"`
	MaxValue *string  `json:"max_value"`
	Values   []string `json:"values"`
}

// Entry is what a signed entry says.
type Entry struct {
	V                  int        `json:"v"`
	Purpose            string     `json:"purpose"`
	ID                 string     `json:"id"`
	OrganisationID     string     `json:"organisation_id"`
	ConnectionID       string     `json:"connection_id"`
	Transport          string     `json:"transport"`
	NodeAddress        string     `json:"node_address"`
	Kind               string     `json:"kind"`
	DataType           string     `json:"data_type"`
	MinValue           *string    `json:"min_value"`
	MaxValue           *string    `json:"max_value"`
	MaxStep            *string    `json:"max_step"`
	MinIntervalSeconds int        `json:"min_interval_seconds"`
	InverseCommand     *string    `json:"inverse_command"`
	SimulatorAddress   *string    `json:"simulator_address"`
	Arguments          []Argument `json:"arguments,omitempty"`
	ObjectID           string     `json:"object_id"`
	AddedBy            string     `json:"added_by"`
	ApprovedBy         string     `json:"approved_by"`
	ApprovedAt         time.Time  `json:"approved_at"`
}

// Decimal reads one of the entry's decimals exactly.
func Decimal(text *string) (*big.Rat, bool) {
	if text == nil {
		return nil, true
	}
	r, ok := new(big.Rat).SetString(*text)
	return r, ok
}

type list struct {
	entries map[string]Entry
	digest  string
}

// Store holds the allow-lists for one agent.
type Store struct {
	mu           sync.RWMutex
	key          ed25519.PublicKey
	keyID        string
	organisation string
	lists        map[string]list
}

// NewStore holds the cell's key (SPKI PEM) for this agent's organisation. Without a key every
// list is refused, and so every physical write.
func NewStore(keyPEM, organisationID string) (*Store, error) {
	s := &Store{organisation: organisationID, lists: map[string]list{}}
	if err := s.Use(keyPEM); err != nil {
		return nil, err
	}
	return s, nil
}

// Use takes the key the cell sent at a renewal; "" keeps the one held.
func (s *Store) Use(keyPEM string) error {
	if keyPEM == "" {
		return nil
	}
	key, id, err := signing.ParsePublicKey(keyPEM)
	if err != nil {
		return errors.New("the allow-list key: " + err.Error())
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.key, s.keyID = key, id
	return nil
}

func entryKey(transport, address string) string { return transport + "\x00" + address }

// Digest is a list's: SHA-256, hex, of its entries' signatures sorted and joined by newlines.
// The cell computes the same over what it sent.
func Digest(signatures []string) string {
	sorted := append([]string(nil), signatures...)
	sort.Strings(sorted)
	sum := sha256.Sum256([]byte(strings.Join(sorted, "\n")))
	return hex.EncodeToString(sum[:])
}

func (s *Store) read(connectionID string, signed protocol.SignedEntry) (Entry, string) {
	if signed.KeyID != s.keyID {
		return Entry{}, RefusedKey
	}
	if !signing.Verify(s.key, Prefix, signed.Entry, signed.Signature) {
		return Entry{}, RefusedSignature
	}
	var e Entry
	decoder := json.NewDecoder(bytes.NewReader([]byte(signed.Entry)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&e); err != nil {
		return Entry{}, RefusedEntry
	}
	ok := e.V == 1 && e.Purpose == "actuation_allowlist_entry" && e.OrganisationID == s.organisation && e.ConnectionID == connectionID &&
		uuidPattern.MatchString(e.ID) && e.NodeAddress != "" && e.MinIntervalSeconds >= 0
	switch e.Transport {
	case "mqtt", "opcua", "webhook":
	default:
		ok = false
	}
	switch e.Kind {
	case "setpoint", "command", "method":
	default:
		ok = false
	}
	for _, d := range []*string{e.MinValue, e.MaxValue, e.MaxStep} {
		if d != nil && !decimalPattern.MatchString(*d) {
			ok = false
		}
	}
	if e.Arguments != nil && !validArguments(e) {
		ok = false
	}
	if !ok {
		return Entry{}, RefusedEntry
	}
	return e, ""
}

// validArguments: a method's, one to ten, each named once, of a known type and bounded as it needs.
func validArguments(e Entry) bool {
	if e.Transport != "opcua" || e.Kind != "method" || len(e.Arguments) == 0 || len(e.Arguments) > 10 {
		return false
	}
	seen := map[string]bool{}
	for _, a := range e.Arguments {
		t, known := ArgumentTypes[a.DataType]
		if !known || a.Name == "" || seen[a.Name] {
			return false
		}
		seen[a.Name] = true
		switch t {
		case 1:
			if a.MinValue != nil || a.MaxValue != nil || a.Values != nil {
				return false
			}
		case 12:
			if a.MinValue != nil || a.MaxValue != nil || len(a.Values) == 0 || len(a.Values) > 50 {
				return false
			}
		default:
			if a.Values != nil || a.MinValue == nil || a.MaxValue == nil || !decimalPattern.MatchString(*a.MinValue) || !decimalPattern.MatchString(*a.MaxValue) {
				return false
			}
			lo, _ := Decimal(a.MinValue)
			hi, _ := Decimal(a.MaxValue)
			if lo == nil || hi == nil || lo.Cmp(hi) > 0 {
				return false
			}
		}
	}
	return true
}

// Replace takes a connection's list as the cell sent it: every entry verified, or none taken.
// It says why a list was refused, or "" when it was taken.
func (s *Store) Replace(connectionID string, entries []protocol.SignedEntry) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.key == nil {
		return RefusedNoKey
	}
	if !uuidPattern.MatchString(connectionID) || len(entries) > maxEntries {
		return RefusedBound
	}
	if len(entries) == 0 {
		delete(s.lists, connectionID)
		return ""
	}
	if _, held := s.lists[connectionID]; !held && len(s.lists) >= maxConnections {
		return RefusedBound
	}
	next := list{entries: make(map[string]Entry, len(entries))}
	signatures := make([]string, 0, len(entries))
	for _, signed := range entries {
		e, reason := s.read(connectionID, signed)
		if reason != "" {
			return reason
		}
		next.entries[entryKey(e.Transport, e.NodeAddress)] = e
		signatures = append(signatures, signed.Signature)
	}
	next.digest = Digest(signatures)
	s.lists[connectionID] = next
	return ""
}

// Digests are the lists held, for the heartbeat.
func (s *Store) Digests() []protocol.AllowlistDigest {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]protocol.AllowlistDigest, 0, len(s.lists))
	for id, l := range s.lists {
		out = append(out, protocol.AllowlistDigest{ConnectionID: id, Digest: l.digest})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ConnectionID < out[j].ConnectionID })
	return out
}

// Lookup is the entry for a node of a connection, if its current signed list has one.
func (s *Store) Lookup(connectionID, transport, address string) (Entry, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	e, ok := s.lists[connectionID].entries[entryKey(transport, address)]
	return e, ok
}
