// SFTP (spec 14.4 "SFTP and file share", 10.4): a server on the customer's network, reached by
// this agent. The cell parses; the agent lists and reads.
//
// The server must be one the host's owner allows (configuration targets), reached at the
// addresses allowed, so a name cannot point elsewhere afterwards. It must present the host key
// whose SHA-256 the connection pins: any other key is refused before authentication, so the
// login is never sent to an impostor. The login is the cell's, sealed to this agent for this
// work (a user with a password, or with a private key and its passphrase); golang.org/x/crypto
// takes the password as a Go string and parses the key into its own structures, so for the
// session they live in Go's heap; the sealed and decoded bytes are cleared when it ends.
// Paths: the base path, the source's relative directory (segments, never ".."), then a name
// with no separator. A directory lists its regular files; a file over its bound is refused,
// never cut, and is sent in chunks that each fit a frame.
package work

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net"
	"net/netip"
	"os"
	"path"
	"strconv"
	"strings"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"silohq.io/agent/internal/login"
	"silohq.io/agent/internal/protocol"
)

// SFTP reaches servers for the targets allowed, with logins sealed to this agent.
type SFTP struct {
	logins  *login.Opener
	targets login.Targets
	// Resolve looks a host up; tests replace it.
	Resolve func(ctx context.Context, host string) ([]netip.Addr, error)
}

func NewSFTP(logins *login.Opener, targets login.Targets) *SFTP {
	return &SFTP{logins: logins, targets: targets, Resolve: resolveHost}
}

func resolveHost(ctx context.Context, host string) ([]netip.Addr, error) {
	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	return ips, err
}

// sftpSession is one SFTP conversation, closed when the work ends.
type sftpSession struct {
	ssh  *ssh.Client
	sftp *sftp.Client
}

func (s *sftpSession) close() {
	if s.sftp != nil {
		_ = s.sftp.Close()
	}
	_ = s.ssh.Close()
}

// fingerprint is OpenSSH's "SHA256:" and unpadded base64 of the key.
func fingerprint(key ssh.PublicKey) string { return ssh.FingerprintSHA256(key) }

func samePin(a, b string) bool {
	x := []byte(strings.TrimRight(a, "="))
	y := []byte(strings.TrimRight(b, "="))
	return len(x) == len(y) && subtle.ConstantTimeCompare(x, y) == 1
}

// open checks the server against the targets, opens the sealed login, verifies the pinned key
// and logs in.
func (s *SFTP) open(ctx context.Context, req protocol.SFTPRequest) (*sftpSession, *protocol.Error) {
	integrity := protocol.NewError(protocol.Integrity, "")
	if req.Host == "" || req.Port < 1 || req.Port > 65535 || !strings.HasPrefix(req.HostKeySHA256, "SHA256:") || (req.BasePath != "" && !strings.HasPrefix(req.BasePath, "/")) {
		return nil, &integrity
	}
	addrs, allowed := s.targets.Allow(ctx, req.Host, s.Resolve)
	if !allowed {
		refusal := protocol.NewError(protocol.TargetRefused, "")
		return nil, &refusal
	}
	if req.Credential == nil || s.logins == nil {
		refusal := refused(login.RefusedNoKey)
		return nil, &refusal
	}
	opened, reason := s.logins.Open(req.Credential, req.ConnectionID, protocol.WorkID(ctx), time.Now())
	if reason != "" {
		refusal := refused(reason)
		return nil, &refusal
	}
	defer opened.Zero()
	var auth ssh.AuthMethod
	switch {
	case opened.PrivateKey != nil:
		var signer ssh.Signer
		var err error
		if opened.Passphrase != nil {
			signer, err = ssh.ParsePrivateKeyWithPassphrase(opened.PrivateKey.Bytes(), opened.Passphrase.Bytes())
		} else {
			signer, err = ssh.ParsePrivateKey(opened.PrivateKey.Bytes())
		}
		if err != nil {
			return nil, sourceRefused(protocol.RefusedLogin)
		}
		auth = ssh.PublicKeys(signer)
	case opened.Password != nil:
		auth = ssh.Password(string(opened.Password.Bytes()))
	default:
		refusal := refused(login.RefusedSealing)
		return nil, &refusal
	}
	host := req.Host
	if len(addrs) > 0 {
		host = addrs[0]
	}
	mismatch := false
	config := &ssh.ClientConfig{
		User: opened.User, Auth: []ssh.AuthMethod{auth}, Timeout: 15 * time.Second,
		// The pinned key, and only it: checked before the login is offered.
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			if !samePin(fingerprint(key), req.HostKeySHA256) {
				mismatch = true
				return errors.New("host key not pinned")
			}
			return nil
		},
	}
	dialer := net.Dialer{Timeout: 15 * time.Second}
	conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(host, strconv.Itoa(req.Port)))
	if err != nil {
		refusal := protocol.NewError(protocol.SourceUnreachable, "")
		return nil, &refusal
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	client, channels, requests, err := ssh.NewClientConn(conn, net.JoinHostPort(req.Host, strconv.Itoa(req.Port)), config)
	if err != nil {
		_ = conn.Close()
		if mismatch {
			return nil, sourceRefused(protocol.RefusedUntrusted)
		}
		return nil, sourceRefused(protocol.RefusedLogin)
	}
	sshClient := ssh.NewClient(client, channels, requests)
	sftpClient, err := sftp.NewClient(sshClient)
	if err != nil {
		_ = sshClient.Close()
		refusal := protocol.NewError(protocol.SourceUnreachable, "")
		return nil, &refusal
	}
	return &sftpSession{ssh: sshClient, sftp: sftpClient}, nil
}

func sftpRefusal(err error) protocol.Error {
	var status *sftp.StatusError
	switch {
	case errors.Is(err, fs.ErrNotExist), errors.Is(err, os.ErrNotExist), errors.As(err, &status) && status.FxCode() == sftp.ErrSSHFxNoSuchFile:
		return *sourceRefused(protocol.RefusedNotFound)
	case errors.Is(err, fs.ErrPermission), errors.As(err, &status) && status.FxCode() == sftp.ErrSSHFxPermissionDenied:
		return *sourceRefused(protocol.RefusedPermission)
	default:
		return protocol.NewError(protocol.SourceUnreachable, "")
	}
}

func decodeSFTP(payload json.RawMessage) (protocol.SFTPRequest, bool) {
	var req protocol.SFTPRequest
	if err := json.NewDecoder(bytes.NewReader(payload)).Decode(&req); err != nil || !segments(req.Directory) {
		return req, false
	}
	return req, true
}

// List emits the directory's regular files as rows, then done; or one error frame.
func (s *SFTP) List(ctx context.Context, payload json.RawMessage, emit Emit) error {
	req, ok := decodeSFTP(payload)
	if !ok {
		return emit(protocol.NewError(protocol.Integrity, ""))
	}
	sess, refusal := s.open(ctx, req)
	if refusal != nil {
		return emit(*refusal)
	}
	defer sess.close()
	entries, err := sess.sftp.ReadDir(path.Join(req.BasePath, req.Directory))
	if err != nil {
		return emit(sftpRefusal(err))
	}
	rows := make([]map[string]any, 0, len(entries))
	for _, e := range entries {
		if !e.Mode().IsRegular() {
			continue
		}
		if len(rows) >= MaxFileEntries {
			return emit(protocol.NewError(protocol.Bounds, ""))
		}
		rows = append(rows, map[string]any{"name": e.Name(), "size": e.Size(), "modifiedAt": e.ModTime().UTC().Format(time.RFC3339Nano)})
	}
	if len(rows) > 0 {
		if err := emit(protocol.NewRows(rows)); err != nil {
			return err
		}
	}
	return emit(protocol.NewDone(len(rows), false))
}

// Read emits the file's bytes as rows of chunks, each with its offset, then done; or one error frame.
func (s *SFTP) Read(ctx context.Context, payload json.RawMessage, emit Emit) error {
	req, ok := decodeSFTP(payload)
	if !ok || req.MaxBytes <= 0 || !segments(req.Name) || strings.Contains(req.Name, "/") {
		return emit(protocol.NewError(protocol.Integrity, ""))
	}
	sess, refusal := s.open(ctx, req)
	if refusal != nil {
		return emit(*refusal)
	}
	defer sess.close()
	file, err := sess.sftp.Open(path.Join(req.BasePath, req.Directory, req.Name))
	if err != nil {
		return emit(sftpRefusal(err))
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return emit(*sourceRefused(protocol.RefusedNotFound))
	}
	if info.Size() > req.MaxBytes {
		return emit(protocol.NewError(protocol.Bounds, ""))
	}
	reader := io.LimitReader(file, req.MaxBytes+1)
	buf := make([]byte, FileChunk)
	var offset int64
	chunks := 0
	for {
		if ctx.Err() != nil {
			return emit(protocol.NewError(protocol.Timeout, ""))
		}
		n, err := io.ReadFull(reader, buf)
		if n > 0 {
			if offset+int64(n) > req.MaxBytes {
				return emit(protocol.NewError(protocol.Bounds, ""))
			}
			if err := emit(protocol.NewRows([]map[string]any{{"offset": offset, "data": base64.StdEncoding.EncodeToString(buf[:n])}})); err != nil {
				return err
			}
			offset += int64(n)
			chunks++
		}
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			break
		}
		if err != nil {
			return emit(sftpRefusal(err))
		}
	}
	return emit(protocol.NewDone(chunks, false))
}
