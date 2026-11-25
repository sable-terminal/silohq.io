// Package identity keeps the agent's key and certificate (spec 10.2, 10.7): "The agent
// generates its key pair locally; the private key never leaves the host." A P-256 key, made
// here and written to the state directory readable by the agent's user alone; the signing
// request carries only its public half.
package identity

import (
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

const (
	keyFile      = "agent.key"
	certFile     = "agent.crt"
	caFile       = "agent-ca.crt"
	identityFile = "identity.json"
)

// Identity is who the cell enrolled this agent as.
type Identity struct {
	AgentID        string    `json:"agentId"`
	OrganisationID string    `json:"organisationId"`
	PoolID         string    `json:"poolId"`
	ExpiresAt      time.Time `json:"expiresAt"`
}

// NewRequest makes a fresh key in the state directory and its signing request (PEM). The key
// replaces any before it only once the certificate for it arrives (Save).
func NewRequest(stateDir, name string) (csrPEM string, pendingKey *ecdsa.PrivateKey, err error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return "", nil, fmt.Errorf("cannot make a key: %w", err)
	}
	der, err := x509.CreateCertificateRequest(rand.Reader, &x509.CertificateRequest{Subject: pkix.Name{CommonName: name}}, key)
	if err != nil {
		return "", nil, fmt.Errorf("cannot make a signing request: %w", err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE REQUEST", Bytes: der})), key, nil
}

// Save writes the key, the certificate the cell issued for it, the agent CA and the identity.
// The certificate must be for this key.
func Save(stateDir string, key *ecdsa.PrivateKey, certificatePEM, caPEM string, id Identity) error {
	block, _ := pem.Decode([]byte(certificatePEM))
	if block == nil {
		return errors.New("the cell sent no certificate")
	}
	cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return fmt.Errorf("the cell's certificate does not parse: %w", err)
	}
	if pub, ok := cert.PublicKey.(*ecdsa.PublicKey); !ok || !pub.Equal(&key.PublicKey) {
		return errors.New("the cell's certificate is not for this agent's key")
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return fmt.Errorf("cannot make the state directory: %w", err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		return err
	}
	idJSON, _ := json.MarshalIndent(id, "", "  ")
	for name, body := range map[string][]byte{
		keyFile:      pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}),
		certFile:     []byte(certificatePEM),
		caFile:       []byte(caPEM),
		identityFile: idJSON,
	} {
		if err := writePrivate(filepath.Join(stateDir, name), body); err != nil {
			return err
		}
	}
	return nil
}

// Load reads the agent's certificate, key, the agent CA and its identity.
func Load(stateDir string) (tls.Certificate, *x509.CertPool, Identity, error) {
	var id Identity
	pair, err := tls.LoadX509KeyPair(filepath.Join(stateDir, certFile), filepath.Join(stateDir, keyFile))
	if err != nil {
		return tls.Certificate{}, nil, id, fmt.Errorf("this agent is not enrolled (run enrol): %w", err)
	}
	caPEM, err := os.ReadFile(filepath.Join(stateDir, caFile))
	if err != nil {
		return tls.Certificate{}, nil, id, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return tls.Certificate{}, nil, id, errors.New("the agent CA certificate does not parse")
	}
	raw, err := os.ReadFile(filepath.Join(stateDir, identityFile))
	if err != nil {
		return tls.Certificate{}, nil, id, err
	}
	if err := json.Unmarshal(raw, &id); err != nil {
		return tls.Certificate{}, nil, id, err
	}
	return pair, pool, id, nil
}

// grantKeyFile holds the key the cell signs execution grants with (spec 10.4).
const grantKeyFile = "grant.pem"

// discoveryKeyFile holds the key the cell signs discovery scans with (spec 10.5).
const discoveryKeyFile = "discovery.pem"

// SaveGrantKey keeps the key the cell signs execution grants with, as the cell sent it at
// enrolment or renewal; a cell that sent none leaves what is there.
func SaveGrantKey(stateDir, keyPEM string) error {
	if keyPEM == "" {
		return nil
	}
	return writePrivate(filepath.Join(stateDir, grantKeyFile), []byte(keyPEM))
}

// LoadGrantKey is the key execution grants are checked against, or "" when the cell sent none.
func LoadGrantKey(stateDir string) (string, error) {
	raw, err := os.ReadFile(filepath.Join(stateDir, grantKeyFile))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	return string(raw), err
}

// SaveDiscoveryKey keeps the key the cell signs discovery scans with, as SaveGrantKey does.
func SaveDiscoveryKey(stateDir, keyPEM string) error {
	if keyPEM == "" {
		return nil
	}
	return writePrivate(filepath.Join(stateDir, discoveryKeyFile), []byte(keyPEM))
}

// LoadDiscoveryKey is the key discovery scans are checked against, or "" when the cell sent none.
func LoadDiscoveryKey(stateDir string) (string, error) {
	raw, err := os.ReadFile(filepath.Join(stateDir, discoveryKeyFile))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	return string(raw), err
}

// The X25519 key logins are sealed to (spec 10.7): made for enrolment and each renewal, pending
// until the cell has its public half, then current; the one before is kept for logins sealed
// before the cell heard of the new one.
const (
	sealingKeyFile         = "sealing.key"
	previousSealingKeyFile = "sealing.previous.key"
	pendingSealingKeyFile  = "sealing.pending.key"
)

// NewSealingKey makes a sealing key, kept pending; its public half, base64, for the cell.
func NewSealingKey(stateDir string) (string, error) {
	key, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return "", err
	}
	if err := writePrivate(filepath.Join(stateDir, pendingSealingKeyFile), key.Bytes()); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(key.PublicKey().Bytes()), nil
}

// TakeSealingKey makes the pending key current, once the cell has its public half.
func TakeSealingKey(stateDir string) error {
	current := filepath.Join(stateDir, sealingKeyFile)
	if _, err := os.Stat(current); err == nil {
		if err := os.Rename(current, filepath.Join(stateDir, previousSealingKeyFile)); err != nil {
			return err
		}
	}
	return os.Rename(filepath.Join(stateDir, pendingSealingKeyFile), current)
}

// LoadSealingKeys are the raw private keys, the current first; none for an agent that has none yet.
func LoadSealingKeys(stateDir string) ([][]byte, error) {
	var keys [][]byte
	for _, name := range []string{sealingKeyFile, previousSealingKeyFile} {
		raw, err := os.ReadFile(filepath.Join(stateDir, name))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		keys = append(keys, raw)
	}
	return keys, nil
}

// writePrivate writes a file readable by the agent's user alone, replacing it whole.
func writePrivate(path string, body []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, body, 0o600); err != nil {
		return fmt.Errorf("cannot write %s: %w", path, err)
	}
	return os.Rename(tmp, path)
}
