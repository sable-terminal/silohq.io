// Package discovery is the agent's read-only discovery (spec 10.5, chapter 19). It is enforced
// here, in the agent's code, not by cell policy: it has no write path, reads structure only
// (never a row), issues catalogue statements from a fixed compiled list, and acts only on a
// scan the cell signed naming this agent, explicit targets, methods, a host bound and an
// expiry, under an authorisation people approved. There is no default subnet and no inference
// from the agent's own address. It is rate limited (50 hosts a second, 2 connections per host)
// and bounded (the authorisation's hosts), and every probe is reported. The host's own
// configuration can switch it off whatever the cell authorises (handled where work arrives).
//
// The sovereign build leaves this package out entirely (cmd/silo-agent, build tag sovereign).
package discovery

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"slices"
	"sync"
	"time"

	"silohq.io/agent/internal/signing"
)

// Prefix is what a scan's signature covers before its text.
const Prefix = "silo.discovery_scan.v1"

// skew allows for clocks a little apart.
const skew = time.Minute

// Methods are spec 19.2's, as the cell names them.
var Methods = []string{MethodPortScan, MethodHostConfig, MethodCatalogue, MethodOPCUA, MethodMQTT}

const (
	MethodPortScan   = "port_scan"
	MethodHostConfig = "host_config"
	MethodCatalogue  = "catalogue_introspection"
	MethodOPCUA      = "opcua_browse"
	MethodMQTT       = "mqtt_observe"
)

// MaxHostsBound is the most hosts any authorisation may name (a /16).
const MaxHostsBound = 65_536

// Signed is a scan as it travels: its JSON text as signed, the key's id and the signature.
type Signed struct {
	Scan      string `json:"scan"`
	KeyID     string `json:"keyId"`
	Signature string `json:"signature"`
}

// Scan is one run the cell asks of this agent, carrying the authorisation people approved as
// its exact text (the document whose hash the approvers quoted).
type Scan struct {
	Version             int       `json:"version"`
	ScanID              string    `json:"scanId"`
	OrganisationID      string    `json:"organisationId"`
	AgentID             string    `json:"agentId"`
	AuthorisationID     string    `json:"authorisationId"`
	Authorisation       string    `json:"authorisation"`
	AuthorisationSHA256 string    `json:"authorisationSha256"`
	IssuedAt            time.Time `json:"issuedAt"`
	// StartBy bounds when the scan may begin: a signed scan is not a standing instruction.
	StartBy time.Time `json:"startBy"`
}

// Authorisation is the approved document (spec 19.2): agent, targets, methods, bound, expiry,
// and the membership that asked.
type Authorisation struct {
	V              int       `json:"v"`
	Kind           string    `json:"kind"`
	ID             string    `json:"id"`
	OrganisationID string    `json:"organisation_id"`
	AgentID        string    `json:"agent_id"`
	Ranges         []string  `json:"ranges"`
	Methods        []string  `json:"methods"`
	MaxHosts       int       `json:"max_hosts"`
	ExpiresAt      time.Time `json:"expires_at"`
	AuthorisedBy   string    `json:"authorised_by"`
}

// Verifier checks scans for one agent.
type Verifier struct {
	organisation string
	agent        string
	now          func() time.Time
	mu           sync.Mutex
	key          ed25519.PublicKey
	keyID        string
	used         map[string]time.Time
}

// NewVerifier holds the key the cell gave this agent (SPKI PEM) for its organisation and id.
// Without a key every scan is refused as unsigned.
func NewVerifier(keyPEM, organisationID, agentID string) (*Verifier, error) {
	v := &Verifier{organisation: organisationID, agent: agentID, now: time.Now, used: map[string]time.Time{}}
	if err := v.Use(keyPEM); err != nil {
		return nil, err
	}
	return v, nil
}

// Use takes the key the cell sent at a renewal; "" keeps the one held.
func (v *Verifier) Use(keyPEM string) error {
	if keyPEM == "" {
		return nil
	}
	key, id, err := signing.ParsePublicKey(keyPEM)
	if err != nil {
		return errors.New("the discovery key: " + err.Error())
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	v.key, v.keyID = key, id
	return nil
}

// Check says why a scan may not run, or "" with what it may do; a scan that may run is spent.
func (v *Verifier) Check(signed *Signed) (Scan, Authorisation, string) {
	var s Scan
	var a Authorisation
	v.mu.Lock()
	key, keyID := v.key, v.keyID
	v.mu.Unlock()
	if signed == nil || key == nil {
		return s, a, "unsigned"
	}
	if signed.KeyID != keyID {
		return s, a, "key_unknown"
	}
	if !signing.Verify(key, Prefix, signed.Scan, signed.Signature) {
		return s, a, "signature"
	}
	if err := json.Unmarshal([]byte(signed.Scan), &s); err != nil || s.Version != 1 || s.ScanID == "" {
		return s, a, "signature"
	}
	now := v.now()
	if !now.Before(s.StartBy.Add(skew)) || s.IssuedAt.After(now.Add(skew)) {
		return s, a, "expired"
	}
	if s.OrganisationID != v.organisation {
		return s, a, "organisation"
	}
	if s.AgentID != v.agent {
		return s, a, "agent"
	}
	sum := sha256.Sum256([]byte(s.Authorisation))
	if hex.EncodeToString(sum[:]) != s.AuthorisationSHA256 {
		return s, a, "authorisation"
	}
	if reason := v.authorisation(s, &a, now); reason != "" {
		return s, a, reason
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	for id, until := range v.used {
		if now.After(until.Add(skew)) {
			delete(v.used, id)
		}
	}
	if _, spent := v.used[s.ScanID]; spent {
		return s, a, "replayed"
	}
	v.used[s.ScanID] = s.StartBy
	return s, a, ""
}

// authorisation reads the approved document and holds it to this agent and to the bounds.
func (v *Verifier) authorisation(s Scan, a *Authorisation, now time.Time) string {
	if err := json.Unmarshal([]byte(s.Authorisation), a); err != nil || a.V != 1 || a.Kind != "discovery_authorisation" {
		return "authorisation"
	}
	if a.ID != s.AuthorisationID || a.OrganisationID != v.organisation {
		return "authorisation"
	}
	if a.AgentID != v.agent {
		return "agent"
	}
	if !now.Before(a.ExpiresAt) {
		return "expired"
	}
	if len(a.Methods) == 0 || len(a.Ranges) == 0 || a.MaxHosts < 1 || a.MaxHosts > MaxHostsBound {
		return "authorisation"
	}
	for _, m := range a.Methods {
		if !slices.Contains(Methods, m) {
			return "authorisation"
		}
	}
	if _, err := ParseTargets(a.Ranges); err != nil {
		return "authorisation"
	}
	return ""
}
