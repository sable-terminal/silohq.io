package discovery

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"encoding/binary"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"
)

// Identification says what answered on an open port, before any credential and without
// asking for data: what the service announces of itself, or its reply to a handshake opening
// that carries no data and changes nothing (Postgres's SSL request, SQL Server's pre-login, an
// HTTP HEAD). Nothing is logged in to, and the connection closes straight after.

const identifyWait = 2 * time.Second

// identify is what answered on conn, or ok false when it could not be told.
func identify(conn net.Conn, host string, port int) (Found, bool) {
	_ = conn.SetDeadline(time.Now().Add(identifyWait))
	switch port {
	case 5432:
		return postgresHandshake(conn, port)
	case 1433:
		return sqlServerPrelogin(conn, port)
	case 80, 8080:
		return httpHead(conn, host, port)
	case 443, 8443:
		return httpsHead(conn, host, port)
	}
	// Anything else: what the service says first, if anything; when it says nothing, the
	// Postgres opening (eight bytes no other protocol takes as a command).
	banner := readBanner(conn, 500*time.Millisecond)
	if len(banner) > 0 {
		return fromBanner(banner, port)
	}
	_ = conn.SetDeadline(time.Now().Add(identifyWait))
	return postgresHandshake(conn, port)
}

func readBanner(conn net.Conn, wait time.Duration) []byte {
	_ = conn.SetReadDeadline(time.Now().Add(wait))
	buf := make([]byte, 512)
	n, _ := conn.Read(buf)
	return buf[:n]
}

// fromBanner recognises a greeting: SSH, MySQL or MariaDB, FTP, SMTP.
func fromBanner(b []byte, port int) (Found, bool) {
	line := string(b)
	if i := strings.IndexAny(line, "\r\n"); i >= 0 {
		line = line[:i]
	}
	switch {
	case strings.HasPrefix(line, "SSH-"):
		// SSH-2.0-OpenSSH_9.6p1 Ubuntu-3: the software, then its version.
		software := strings.SplitN(strings.TrimPrefix(line, "SSH-"), "-", 2)
		if len(software) < 2 {
			return service(port, "SSH server", "", "sftp", ""), true
		}
		name, version, _ := strings.Cut(strings.Fields(software[1] + " ")[0], "_")
		return service(port, name, version, "sftp", ""), true
	case len(b) > 5 && b[3] == 0 && b[4] == 0x0a:
		// A MySQL protocol 10 greeting: length, sequence 0, then the server version, NUL-ended.
		version, _, _ := bytes.Cut(b[5:], []byte{0})
		product := "MySQL"
		if bytes.Contains(bytes.ToLower(version), []byte("mariadb")) {
			product = "MariaDB"
		}
		return service(port, product, strings.Fields(string(version) + " ")[0], "sql", "mysql"), true
	case len(b) > 5 && b[3] == 0 && b[4] == 0xff:
		// A MySQL error packet before any login (this host is not allowed): still MySQL.
		return service(port, "MySQL", "", "sql", "mysql"), true
	case strings.HasPrefix(line, "220 ") || strings.HasPrefix(line, "220-"):
		if strings.Contains(strings.ToUpper(line), "FTP") {
			return service(port, "FTP server", "", "other", ""), true
		}
		if strings.Contains(strings.ToUpper(line), "SMTP") || strings.Contains(strings.ToUpper(line), "ESMTP") {
			return service(port, "SMTP server", "", "other", ""), true
		}
	}
	return Found{}, false
}

// postgresHandshake sends Postgres's SSL request; a Postgres server answers one byte, S or N.
func postgresHandshake(conn net.Conn, port int) (Found, bool) {
	request := make([]byte, 8)
	binary.BigEndian.PutUint32(request[0:4], 8)
	binary.BigEndian.PutUint32(request[4:8], 80877103)
	if _, err := conn.Write(request); err != nil {
		return Found{}, false
	}
	reply := make([]byte, 2)
	n, _ := conn.Read(reply)
	if n == 1 && (reply[0] == 'S' || reply[0] == 'N') {
		return service(port, "PostgreSQL", "", "sql", "postgres"), true
	}
	return Found{}, false
}

// sqlServerPrelogin sends a TDS pre-login asking nothing but the version, encryption declined.
func sqlServerPrelogin(conn net.Conn, port int) (Found, bool) {
	payload := []byte{
		0x00, 0x00, 0x0b, 0x00, 0x06, // VERSION at 11, 6 bytes
		0x01, 0x00, 0x11, 0x00, 0x01, // ENCRYPTION at 17, 1 byte
		0xff,
		0, 0, 0, 0, 0, 0, // version (the client's: none)
		0x02, // encryption not supported
	}
	packet := append([]byte{0x12, 0x01, 0, byte(8 + len(payload)), 0, 0, 1, 0}, payload...)
	if _, err := conn.Write(packet); err != nil {
		return Found{}, false
	}
	header := make([]byte, 8)
	if _, err := readFull(conn, header); err != nil || header[0] != 0x04 {
		return Found{}, false
	}
	length := int(binary.BigEndian.Uint16(header[2:4])) - 8
	if length <= 0 || length > 4096 {
		return Found{}, false
	}
	body := make([]byte, length)
	if _, err := readFull(conn, body); err != nil {
		return Found{}, false
	}
	for i := 0; i+5 <= len(body) && body[i] != 0xff; i += 5 {
		if body[i] != 0x00 {
			continue
		}
		off, n := int(binary.BigEndian.Uint16(body[i+1:])), int(binary.BigEndian.Uint16(body[i+3:]))
		if n >= 4 && off+n <= len(body) {
			v := body[off:]
			return service(port, "Microsoft SQL Server", fmt.Sprintf("%d.%d.%d", v[0], v[1], binary.BigEndian.Uint16(v[2:4])), "sql", "sqlserver"), true
		}
	}
	return service(port, "Microsoft SQL Server", "", "sql", "sqlserver"), true
}

func readFull(conn net.Conn, buf []byte) (int, error) {
	total := 0
	for total < len(buf) {
		n, err := conn.Read(buf[total:])
		total += n
		if err != nil {
			return total, err
		}
	}
	return total, nil
}

// httpHead asks for the headers of /, and reads the server's name from them.
func httpHead(conn net.Conn, host string, port int) (Found, bool) {
	if _, err := fmt.Fprintf(conn, "HEAD / HTTP/1.1\r\nHost: %s\r\nUser-Agent: silo-agent-discovery\r\nConnection: close\r\n\r\n", host); err != nil {
		return Found{}, false
	}
	res, err := http.ReadResponse(bufio.NewReaderSize(conn, 4096), nil)
	if err != nil {
		return Found{}, false
	}
	_ = res.Body.Close()
	name, version, _ := strings.Cut(strings.Fields(res.Header.Get("Server") + " ")[0], "/")
	if name == "" {
		name = "HTTP server"
	}
	return service(port, name, version, "rest", ""), true
}

// httpsHead is httpHead over TLS. The certificate is not checked: nothing is sent that needs
// the server to be who it says, and recognising it is the point.
func httpsHead(conn net.Conn, host string, port int) (Found, bool) {
	name := host
	if net.ParseIP(host) != nil {
		name = ""
	}
	client := tls.Client(conn, &tls.Config{ServerName: name, InsecureSkipVerify: true, MinVersion: tls.VersionTLS12}) //nolint:gosec // identification only
	if err := client.Handshake(); err != nil {
		return Found{}, false
	}
	return httpHead(client, host, port)
}
