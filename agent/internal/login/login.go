// Package login opens the database logins the cell keeps for this agent's connections (spec
// 10.7: "Cell-held by default: credential unwraps for one call and passes the secret through the
// tunnel; the agent zeroes it after the call").
//
// The cell's credential service seals each login to this agent's own X25519 key with HPKE (RFC
// 9180: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM; Go's crypto/hpke), for one piece of
// work. The HPKE info binds it to this organisation, this agent, the connection and the work's
// id, so a login sealed for one piece of work opens for no other, and none opens after its
// expiry. The agent's private key never leaves its state directory; a new one is made at each
// certificate renewal, and the one before is kept for work sealed before the cell heard.
//
// The password is unescaped straight into pages outside Go's heap, locked into memory where the
// host allows (Secret), and wiped when the call ends; it is never made into a Go string of its
// own. The copies made while it is decrypted and parsed are wiped at once.
package login

import (
	"crypto/ecdh"
	"crypto/hpke"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sync"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"silohq.io/agent/internal/protocol"
)

// Info is the HPKE info's purpose; the binding follows a NUL.
const Info = "silo.agent_credential.v1"

// KeyInfo is the purpose of an OPC UA application key sealed for one piece of work (spec 20.3).
const KeyInfo = "silo.agent_opcua_key.v1"

// Refusals, as the cell's error frame names them.
const (
	RefusedNoKey   = "no_key"
	RefusedSealing = "sealing"
	RefusedExpired = "expired"
	RefusedTarget  = "target"
)

var uuid = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// Login is an opened login, for one call. Zero it when the call ends.
type Login struct {
	Host     string
	Port     string
	Database string
	SSLMode  string
	User     string
	// Password is nil for an SSH key login, which carries PrivateKey (PEM) and an optional Passphrase instead.
	Password   *Secret
	PrivateKey *Secret
	Passphrase *Secret
}

// Zero wipes the secrets and returns their pages.
func (l *Login) Zero() {
	if l == nil {
		return
	}
	l.Password.Destroy()
	l.PrivateKey.Destroy()
	l.Passphrase.Destroy()
}

// Opener opens logins sealed to this agent's keys.
type Opener struct {
	mu             sync.RWMutex
	keys           []hpke.PrivateKey
	agentID, orgID string
}

// NewOpener opens with these raw X25519 private keys, the current first.
func NewOpener(agentID, organisationID string, keys ...[]byte) (*Opener, error) {
	o := &Opener{agentID: agentID, orgID: organisationID}
	return o, o.Use(keys...)
}

// Use replaces the keys: after a renewal, the new one and the one before.
func (o *Opener) Use(keys ...[]byte) error {
	kem := hpke.DHKEM(ecdh.X25519())
	parsed := make([]hpke.PrivateKey, 0, len(keys))
	for _, raw := range keys {
		if len(raw) == 0 {
			continue
		}
		key, err := kem.NewPrivateKey(raw)
		if err != nil {
			return errors.New("a sealing key does not parse")
		}
		parsed = append(parsed, key)
	}
	o.mu.Lock()
	o.keys = parsed
	o.mu.Unlock()
	return nil
}

// info is what the cell bound the sealed value to: canonical JSON, keys sorted, of ids only.
func (o *Opener) info(purpose, connectionID, workID string) []byte {
	return fmt.Appendf([]byte(purpose+"\x00"), `{"agentId":%q,"connectionId":%q,"organisationId":%q,"workId":%q}`,
		o.agentID, connectionID, o.orgID, workID)
}

// open decrypts what the cell sealed for this purpose, connection and work: the plaintext, to be
// cleared by the caller, or why not.
func (o *Opener) open(purpose string, sealed *protocol.SealedLogin, connectionID, workID string, now time.Time) ([]byte, string) {
	o.mu.RLock()
	keys := o.keys
	o.mu.RUnlock()
	if len(keys) == 0 {
		return nil, RefusedNoKey
	}
	if sealed == nil || !uuid.MatchString(connectionID) || !uuid.MatchString(workID) {
		return nil, RefusedSealing
	}
	if !now.Before(sealed.ExpiresAt) {
		return nil, RefusedExpired
	}
	ciphertext, err := base64.StdEncoding.DecodeString(sealed.Sealed)
	if err != nil {
		return nil, RefusedSealing
	}
	info := o.info(purpose, connectionID, workID)
	for _, key := range keys {
		if plaintext, err := hpke.Open(key, hpke.HKDFSHA256(), hpke.AES256GCM(), info, ciphertext); err == nil {
			return plaintext, ""
		}
	}
	return nil, RefusedSealing
}

// Open opens a login sealed for this connection and piece of work, or says why not.
func (o *Opener) Open(sealed *protocol.SealedLogin, connectionID, workID string, now time.Time) (*Login, string) {
	plaintext, reason := o.open(Info, sealed, connectionID, workID, now)
	if reason != "" {
		return nil, reason
	}
	login, ok := parse(plaintext, now)
	clear(plaintext)
	if !ok {
		return nil, RefusedSealing
	}
	if login == nil {
		return nil, RefusedExpired
	}
	return login, ""
}

// OpenKey opens an OPC UA application key sealed for this connection and piece of work: the
// RSA key, or why not. The key lives in Go's heap for the call (crypto/rsa needs it there); the
// sealed and decoded bytes are cleared at once.
func (o *Opener) OpenKey(sealed *protocol.SealedLogin, connectionID, workID string, now time.Time) (*rsa.PrivateKey, string) {
	plaintext, reason := o.open(KeyInfo, sealed, connectionID, workID, now)
	if reason != "" {
		return nil, reason
	}
	defer clear(plaintext)
	var doc struct {
		ExpiresAt  time.Time `json:"expiresAt"`
		PrivateKey []byte    `json:"privateKey"`
	}
	if err := json.Unmarshal(plaintext, &doc); err != nil {
		return nil, RefusedSealing
	}
	defer clear(doc.PrivateKey)
	if !now.Before(doc.ExpiresAt) {
		return nil, RefusedExpired
	}
	parsed, err := x509.ParsePKCS8PrivateKey(doc.PrivateKey)
	if err != nil {
		return nil, RefusedSealing
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, RefusedSealing
	}
	return key, ""
}

// sealedDocument is what the cell sealed. The password stays as its JSON text, unescaped by
// hand into bytes the agent owns.
type sealedDocument struct {
	ExpiresAt time.Time         `json:"expiresAt"`
	Params    map[string]string `json:"params"`
	Username  *string           `json:"username"`
	Password  json.RawMessage   `json:"password"`
	// An SSH key login (SFTP, spec 14.4): the key as PEM, and its passphrase where it has one.
	PrivateKey json.RawMessage `json:"privateKey"`
	Passphrase json.RawMessage `json:"passphrase"`
}

// parse reads the document: nil and true when it has expired inside.
func parse(plaintext []byte, now time.Time) (*Login, bool) {
	var doc sealedDocument
	if err := json.Unmarshal(plaintext, &doc); err != nil {
		return nil, false
	}
	defer clear(doc.Password)
	defer clear(doc.PrivateKey)
	defer clear(doc.Passphrase)
	if !now.Before(doc.ExpiresAt) {
		return nil, true
	}
	login := &Login{Host: doc.Params["host"], Port: doc.Params["port"], Database: doc.Params["database"], SSLMode: doc.Params["sslmode"]}
	present := func(raw json.RawMessage) bool { return len(raw) > 0 && string(raw) != "null" }
	if present(doc.PrivateKey) {
		key, ok := unquote(doc.PrivateKey)
		if !ok {
			key.Destroy()
			return nil, false
		}
		login.PrivateKey = key
		if present(doc.Passphrase) {
			phrase, ok := unquote(doc.Passphrase)
			if !ok {
				login.Zero()
				phrase.Destroy()
				return nil, false
			}
			login.Passphrase = phrase
		}
	} else {
		password, ok := unquote(doc.Password)
		if !ok {
			password.Destroy()
			return nil, false
		}
		login.Password = password
	}
	if doc.Username != nil {
		login.User = *doc.Username
	}
	// A database login names its host and database (checked where a database is opened); an
	// industrial login (MQTT, OPC UA) names neither: the endpoint comes with the work.
	return login, true
}

// unquote unescapes a JSON string literal straight into a Secret, never a Go string. Unescaped
// text is never longer than its literal, so the Secret is sized once and never grows.
func unquote(literal []byte) (*Secret, bool) {
	if len(literal) < 2 || literal[0] != '"' || literal[len(literal)-1] != '"' {
		return nil, false
	}
	in := literal[1 : len(literal)-1]
	secret, err := newSecret(len(in))
	if err != nil {
		return nil, false
	}
	out := secret.Bytes()
	at := 0
	fail := func() (*Secret, bool) {
		secret.Destroy()
		return nil, false
	}
	for i := 0; i < len(in); i++ {
		c := in[i]
		if c != '\\' {
			out[at] = c
			at++
			continue
		}
		if i+1 >= len(in) {
			return fail()
		}
		i++
		switch in[i] {
		case '"', '\\', '/':
			out[at] = in[i]
		case 'b':
			out[at] = '\b'
		case 'f':
			out[at] = '\f'
		case 'n':
			out[at] = '\n'
		case 'r':
			out[at] = '\r'
		case 't':
			out[at] = '\t'
		case 'u':
			r, n, ok := hex4(in[i+1:])
			if !ok {
				return fail()
			}
			i += n
			if utf16.IsSurrogate(r) {
				if len(in) > i+2 && in[i+1] == '\\' && in[i+2] == 'u' {
					if low, m, ok := hex4(in[i+3:]); ok {
						r = utf16.DecodeRune(r, low)
						i += 2 + m
					}
				}
			}
			at += utf8.EncodeRune(out[at:], r)
			continue
		default:
			return fail()
		}
		at++
	}
	secret.keep(at)
	return secret, true
}

func hex4(b []byte) (rune, int, bool) {
	if len(b) < 4 {
		return 0, 0, false
	}
	var r rune
	for _, c := range b[:4] {
		r <<= 4
		switch {
		case c >= '0' && c <= '9':
			r |= rune(c - '0')
		case c >= 'a' && c <= 'f':
			r |= rune(c - 'a' + 10)
		case c >= 'A' && c <= 'F':
			r |= rune(c - 'A' + 10)
		default:
			return 0, 0, false
		}
	}
	return r, 4, true
}
