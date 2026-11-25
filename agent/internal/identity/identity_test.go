package identity

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// issue signs a certificate for the request's key, as the cell's CA would.
func issue(t *testing.T, csrPEM string) (string, string) {
	t.Helper()
	block, _ := pem.Decode([]byte(csrPEM))
	csr, err := x509.ParseCertificateRequest(block.Bytes)
	if err != nil || csr.CheckSignature() != nil {
		t.Fatalf("request: %v", err)
	}
	caKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	caTemplate := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "ca"}, NotBefore: time.Now().Add(-time.Hour),
		NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign}
	caDER, _ := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	ca, _ := x509.ParseCertificate(caDER)
	leaf := &x509.Certificate{SerialNumber: big.NewInt(2), Subject: pkix.Name{CommonName: "agent"}, NotBefore: time.Now().Add(-time.Hour),
		NotAfter: time.Now().Add(time.Hour), ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth}}
	der, err := x509.CreateCertificate(rand.Reader, leaf, ca, csr.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})), string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER}))
}

func TestTheKeyStaysHereAndOnlyItsOwnCertificateIsKept(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "state")
	csr, key, err := NewRequest(dir, "plant-a")
	if err != nil {
		t.Fatal(err)
	}
	cert, ca := issue(t, csr)
	other, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err := Save(dir, other, cert, ca, Identity{AgentID: "a"}); err == nil {
		t.Fatal("a certificate for another key was kept")
	}
	if err := Save(dir, key, cert, ca, Identity{AgentID: "a", OrganisationID: "o", PoolID: "p"}); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(dir, "agent.key"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("the key is readable by others: %v %v", info.Mode(), err)
	}
	_, pool, id, err := Load(dir)
	if err != nil || pool == nil || id.AgentID != "a" {
		t.Fatalf("load: %+v %v", id, err)
	}
}
