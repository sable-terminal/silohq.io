// Package signing holds what every cell-signed instruction shares: the cell's Ed25519 public
// key, given at enrolment as SubjectPublicKeyInfo PEM and named by the base64url SHA-256 of
// its DER, and a signature over a fixed purpose prefix, a NUL and the instruction's JSON text
// exactly as it arrived. The prefix keeps one purpose's signature from passing as another's.
package signing

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"errors"
)

// ParsePublicKey reads an Ed25519 key from SPKI PEM, with its id.
func ParsePublicKey(keyPEM string) (ed25519.PublicKey, string, error) {
	block, _ := pem.Decode([]byte(keyPEM))
	if block == nil {
		return nil, "", errors.New("the key is not PEM")
	}
	parsed, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, "", errors.New("the key does not parse")
	}
	key, ok := parsed.(ed25519.PublicKey)
	if !ok {
		return nil, "", errors.New("the key is not Ed25519")
	}
	sum := sha256.Sum256(block.Bytes)
	return key, base64.RawURLEncoding.EncodeToString(sum[:]), nil
}

// Verify says whether signature (base64url) is key's over prefix, NUL and text.
func Verify(key ed25519.PublicKey, prefix, text, signature string) bool {
	raw, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil || len(key) != ed25519.PublicKeySize {
		return false
	}
	message := make([]byte, 0, len(prefix)+1+len(text))
	message = append(append(append(message, prefix...), 0), text...)
	return ed25519.Verify(key, message, raw)
}
