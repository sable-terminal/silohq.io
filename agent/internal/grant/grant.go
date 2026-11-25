// Package grant checks execution grants on this host (spec 10.4: "Write-back: only on a signed
// execution grant from actions naming Action, connection, target and payload hash, verified
// locally. Unsigned or mismatched writes are refused").
//
// The cell's actions signs a grant with Ed25519 over a fixed prefix and the grant's JSON text,
// which arrives as that text: the signature is checked over exactly those bytes, with the key
// the cell gave this agent at enrolment (or renewal), never one a grant names. The grant must be
// this agent's organisation's, for the connection the write is on, unexpired, for exactly as
// many statements, and its payload hash must be SHA-256 of the statements exactly as they
// arrived. A grant runs once.
package grant

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"silohq.io/agent/internal/signing"
)

// Prefix is what the signature covers before the grant's text.
const Prefix = "silo.execution_grant.v1"

// skew allows for clocks a little apart.
const skew = time.Minute

// Signed is a grant as it travels: its JSON text as signed, the key's id and the signature.
type Signed struct {
	Grant     string `json:"grant"`
	KeyID     string `json:"keyId"`
	Signature string `json:"signature"`
}

// Grant is what a grant says.
type Grant struct {
	Version        int       `json:"version"`
	GrantID        string    `json:"grantId"`
	OrganisationID string    `json:"organisationId"`
	ActionID       string    `json:"actionId"`
	ActionKind     string    `json:"actionKind"`
	ConnectionID   string    `json:"connectionId"`
	Object         string    `json:"object"`
	Statements     int       `json:"statements"`
	PayloadSHA256  string    `json:"payloadSha256"`
	IssuedAt       time.Time `json:"issuedAt"`
	ExpiresAt      time.Time `json:"expiresAt"`
}

// Verifier checks grants for one agent.
type Verifier struct {
	key          ed25519.PublicKey
	keyID        string
	organisation string
	now          func() time.Time
	mu           sync.Mutex
	used         map[string]time.Time
}

// NewVerifier holds the key the cell gave this agent (SPKI PEM), for its organisation. Without
// a key every write is refused as unsigned.
func NewVerifier(keyPEM, organisationID string) (*Verifier, error) {
	v := &Verifier{organisation: organisationID, now: time.Now, used: map[string]time.Time{}}
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
		return errors.New("the grant key: " + err.Error())
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	v.key, v.keyID = key, id
	return nil
}

// Check says why a grant does not cover this write, or "" when it does; a grant that covers
// it is spent. statements are the statements' JSON exactly as they arrived.
func (v *Verifier) Check(signed *Signed, connectionID string, statements json.RawMessage, count int) (Grant, string) {
	var g Grant
	v.mu.Lock()
	key, keyID := v.key, v.keyID
	v.mu.Unlock()
	if signed == nil || key == nil {
		return g, "unsigned"
	}
	if signed.KeyID != keyID {
		return g, "key_unknown"
	}
	if !signing.Verify(key, Prefix, signed.Grant, signed.Signature) {
		return g, "signature"
	}
	if err := json.Unmarshal([]byte(signed.Grant), &g); err != nil || g.Version != 1 || g.GrantID == "" {
		return g, "signature"
	}
	now := v.now()
	if !now.Before(g.ExpiresAt) || g.IssuedAt.After(now.Add(skew)) {
		return g, "expired"
	}
	if g.OrganisationID != v.organisation {
		return g, "organisation"
	}
	if g.ConnectionID != connectionID {
		return g, "connection"
	}
	if g.Statements != count {
		return g, "statements"
	}
	sum := sha256.Sum256(statements)
	if hex.EncodeToString(sum[:]) != g.PayloadSHA256 {
		return g, "payload"
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	for id, until := range v.used {
		if now.After(until.Add(skew)) {
			delete(v.used, id)
		}
	}
	if _, spent := v.used[g.GrantID]; spent {
		return g, "replayed"
	}
	v.used[g.GrantID] = g.ExpiresAt
	return g, ""
}
