package work

import (
	"context"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hpke"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"silohq.io/agent/internal/login"
	"silohq.io/agent/internal/protocol"
)

// sftpServer serves root over SFTP on the loopback, for a password or one authorised key.
func sftpServer(t *testing.T, root, password string, authorised ssh.PublicKey) (port int, pin string) {
	t.Helper()
	_, hostKey, _ := ed25519.GenerateKey(rand.Reader)
	signer, err := ssh.NewSignerFromKey(hostKey)
	if err != nil {
		t.Fatal(err)
	}
	config := &ssh.ServerConfig{
		PasswordCallback: func(_ ssh.ConnMetadata, given []byte) (*ssh.Permissions, error) {
			if string(given) == password {
				return nil, nil
			}
			return nil, fmt.Errorf("refused")
		},
		PublicKeyCallback: func(_ ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			if authorised != nil && string(key.Marshal()) == string(authorised.Marshal()) {
				return nil, nil
			}
			return nil, fmt.Errorf("refused")
		},
	}
	config.AddHostKey(signer)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				_, channels, requests, err := ssh.NewServerConn(conn, config)
				if err != nil {
					return
				}
				go ssh.DiscardRequests(requests)
				for ch := range channels {
					if ch.ChannelType() != "session" {
						_ = ch.Reject(ssh.UnknownChannelType, "")
						continue
					}
					channel, reqs, err := ch.Accept()
					if err != nil {
						return
					}
					go func() {
						for req := range reqs {
							ok := req.Type == "subsystem" && len(req.Payload) > 4 && string(req.Payload[4:]) == "sftp"
							_ = req.Reply(ok, nil)
							if ok {
								server, err := sftp.NewServer(channel, sftp.WithServerWorkingDirectory(root))
								if err == nil {
									_ = server.Serve()
								}
								_ = channel.Close()
							}
						}
					}()
				}
			}()
		}
	}()
	return listener.Addr().(*net.TCPAddr).Port, ssh.FingerprintSHA256(signer.PublicKey())
}

// sealSFTP seals a login document as the cell's credential service does, for testConnID and the work.
func sealSFTP(t *testing.T, to *ecdh.PublicKey, document map[string]any, work string) *protocol.SealedLogin {
	t.Helper()
	document["expiresAt"] = time.Now().Add(time.Minute).Format(time.RFC3339Nano)
	document["params"] = map[string]string{}
	plaintext, _ := json.Marshal(document)
	pub, err := hpke.DHKEM(ecdh.X25519()).NewPublicKey(to.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	info := fmt.Sprintf("%s\x00{\"agentId\":%q,\"connectionId\":%q,\"organisationId\":%q,\"workId\":%q}", login.Info, testAgentID, testConnID, testOrgID, work)
	sealed, err := hpke.Seal(pub, hpke.HKDFSHA256(), hpke.AES256GCM(), []byte(info), plaintext)
	if err != nil {
		t.Fatal(err)
	}
	return &protocol.SealedLogin{Sealed: base64.StdEncoding.EncodeToString(sealed), ExpiresAt: time.Now().Add(time.Minute)}
}

func TestSFTPListsAndReadsPinnedWithEitherLogin(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "exports", "nested"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "exports", "orders-1.csv"), []byte("id,region\n1,north\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, userKey, _ := ed25519.GenerateKey(rand.Reader)
	userSigner, _ := ssh.NewSignerFromKey(userKey)
	port, pin := sftpServer(t, root, "s3cret", userSigner.PublicKey())

	sealing, _ := ecdh.X25519().GenerateKey(rand.Reader)
	opener, err := login.NewOpener(testAgentID, testOrgID, sealing.Bytes())
	if err != nil {
		t.Fatal(err)
	}
	targets, _ := login.ParseTargets([]string{"127.0.0.1"})
	s := NewSFTP(opener, targets)
	der, _ := x509.MarshalPKCS8PrivateKey(userKey)
	keyPEM := string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))

	run := func(handler func(ctx context.Context, payload json.RawMessage, emit Emit) error, req protocol.SFTPRequest, doc map[string]any) []map[string]any {
		work := fmt.Sprintf("0190f4a8-0000-7000-8000-%012d", time.Now().UnixNano()%1_000_000_000_000)
		req.Credential = sealSFTP(t, sealing.PublicKey(), doc, work)
		return runWork(t, handler, req, work)
	}
	base := protocol.SFTPRequest{ConnectionID: testConnID, Host: "127.0.0.1", Port: port, HostKeySHA256: pin, Directory: "exports"}

	listed := run(s.List, base, map[string]any{"username": "reader", "password": "s3cret"})
	if listed[0]["type"] != "rows" || len(listed[0]["rows"].([]any)) != 1 || listed[0]["rows"].([]any)[0].(map[string]any)["name"] != "orders-1.csv" {
		t.Fatalf("listed %v: the regular file, not the nested directory", listed)
	}
	read := base
	read.Name, read.MaxBytes = "orders-1.csv", 1000
	got := run(s.Read, read, map[string]any{"username": "reader", "password": nil, "privateKey": keyPEM, "passphrase": nil})
	data, _ := base64.StdEncoding.DecodeString(got[0]["rows"].([]any)[0].(map[string]any)["data"].(string))
	if string(data) != "id,region\n1,north\n" {
		t.Fatalf("read with a key: %q (%v)", data, got)
	}

	// Another host key is refused before the login is offered; a wrong password is the login's refusal.
	wrong := base
	wrong.HostKeySHA256 = "SHA256:" + base64.RawStdEncoding.EncodeToString(make([]byte, 32))
	if out := run(s.List, wrong, map[string]any{"username": "reader", "password": "s3cret"}); out[0]["category"] != protocol.SourceRefused || out[0]["reason"] != protocol.RefusedUntrusted {
		t.Fatalf("an unpinned key: %v", out)
	}
	if out := run(s.List, base, map[string]any{"username": "reader", "password": "nope"}); out[0]["category"] != protocol.SourceRefused || out[0]["reason"] != protocol.RefusedLogin {
		t.Fatalf("a refused login: %v", out)
	}
	// A host the owner does not allow; a file over its bound; a directory not there.
	elsewhere := NewSFTP(opener, mustTargets(t, "10.0.0.0/8"))
	if out := run(elsewhere.List, base, map[string]any{"username": "reader", "password": "s3cret"}); out[0]["category"] != protocol.TargetRefused {
		t.Fatalf("outside the targets: %v", out)
	}
	small := read
	small.MaxBytes = 4
	if out := run(s.Read, small, map[string]any{"username": "reader", "password": "s3cret"}); out[0]["category"] != protocol.Bounds {
		t.Fatalf("over its bound: %v", out)
	}
	missing := base
	missing.Directory = "nowhere"
	if out := run(s.List, missing, map[string]any{"username": "reader", "password": "s3cret"}); out[0]["reason"] != protocol.RefusedNotFound {
		t.Fatalf("a missing directory: %v", out)
	}
}

// runWork runs a handler as the piece of work named, and returns what it emitted.
func runWork(t *testing.T, handler func(context.Context, json.RawMessage, Emit) error, payload any, work string) []map[string]any {
	t.Helper()
	raw, _ := json.Marshal(payload)
	var out []map[string]any
	ctx, cancel := context.WithTimeout(protocol.WithWorkID(context.Background(), work), 30*time.Second)
	defer cancel()
	if err := handler(ctx, raw, func(frame any) error {
		b, _ := json.Marshal(frame)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		out = append(out, m)
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return out
}

func mustTargets(t *testing.T, list ...string) login.Targets {
	t.Helper()
	targets, err := login.ParseTargets(list)
	if err != nil {
		t.Fatal(err)
	}
	return targets
}
