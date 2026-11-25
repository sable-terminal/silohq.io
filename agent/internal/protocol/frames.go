// Package protocol holds the agent tunnel's frames (spec 10.2), as the cell defines them in
// app/server/src/contracts/connect-runtime/agentTunnel.contract.ts: newline-delimited JSON,
// heartbeats up the tunnel, work and close frames down it, and result frames up each work
// stream. A change here is a change there.
package protocol

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"time"
)

const (
	EnrolPath      = "/v1/enrol"
	RenewPath      = "/v1/renew"
	TunnelPath     = "/v1/tunnel"
	WorkPathPrefix = "/v1/work/"
	CDCPathPrefix  = "/v1/cdc/"
	// MaxCDCReaders is spec 10.7's bound.
	MaxCDCReaders = 16
	// MaxSpooledSlots bounds the spools a heartbeat names.
	MaxSpooledSlots = 64
	// MaxFrameBytes bounds one frame, as the cell bounds it.
	MaxFrameBytes = 4 * 1024 * 1024
	// RowsPerFrame is how many rows the agent sends in one rows frame.
	RowsPerFrame = 500
)

// EnrolRequest is the agent's one call without a client certificate.
type EnrolRequest struct {
	Token    string `json:"token"`
	CSR      string `json:"csr"`
	Name     string `json:"name"`
	Hostname string `json:"hostname"`
	Platform string `json:"platform"`
	Version  string `json:"version"`
	// SealingKey is the X25519 public key logins are sealed to (spec 10.7), base64.
	SealingKey string `json:"sealingKey,omitempty"`
}

// RenewRequest asks for a certificate for a new key, over mutual TLS with the current one, and
// gives a new sealing key with it.
type RenewRequest struct {
	CSR        string `json:"csr"`
	SealingKey string `json:"sealingKey,omitempty"`
}

// EnrolResponse is what the cell's agent CA issued (for enrolment and renewal alike).
type EnrolResponse struct {
	AgentID        string    `json:"agentId"`
	OrganisationID string    `json:"organisationId"`
	PoolID         string    `json:"poolId"`
	Certificate    string    `json:"certificate"`
	CACertificate  string    `json:"caCertificate"`
	ExpiresAt      time.Time `json:"expiresAt"`
	// GrantKey is the key execution grants are signed with (SPKI PEM): writes run only on a grant it verifies.
	GrantKey string `json:"grantKey,omitempty"`
	// DiscoveryKey is the key discovery scans are signed with (SPKI PEM): a scan runs only when it verifies.
	DiscoveryKey string `json:"discoveryKey,omitempty"`
}

// Heartbeat goes up the tunnel every ten seconds.
type Heartbeat struct {
	Type              string `json:"type"`
	Version           string `json:"version"`
	ActiveCalls       int    `json:"activeCalls"`
	CDCReaders        int    `json:"cdcReaders"`
	DiscoveryDisabled bool   `json:"discoveryDisabled"`
	// CDCSlots are the slots read here; CDCSpooled the spools holding what only they have.
	CDCSlots   []string `json:"cdcSlots,omitempty"`
	CDCSpooled []string `json:"cdcSpooled,omitempty"`
	// Allowlists are the signed actuation allow-lists held, by connection (spec 47.4).
	Allowlists []AllowlistDigest `json:"allowlists,omitempty"`
}

// AllowlistDigest is a held allow-list's digest: what the cell compares with the current list's.
type AllowlistDigest struct {
	ConnectionID string `json:"connectionId"`
	Digest       string `json:"digest"`
}

// SignedEntry is an allow-list entry as it travels: its canonical text as signed, the key's id
// and the signature (base64url).
type SignedEntry struct {
	Entry     string `json:"entry"`
	KeyID     string `json:"keyId"`
	Signature string `json:"signature"`
}

// Down is a frame the cell sends down the tunnel: work, close, or a change-capture
// instruction (cdc.start, cdc.ack, cdc.gap_ack, cdc.stop, cdc.drop).
type Down struct {
	Type     string          `json:"type"`
	ID       string          `json:"id,omitempty"`
	Kind     string          `json:"kind,omitempty"`
	Deadline time.Time       `json:"deadline,omitempty"`
	Payload  json.RawMessage `json:"payload,omitempty"`
	Reason   string          `json:"reason,omitempty"`
	// Change capture: the slot (connect.cdc_slots), and for cdc.start what to read from where.
	SlotID       string `json:"slotId,omitempty"`
	ConnectionID string `json:"connectionId,omitempty"`
	Method       string `json:"method,omitempty"`
	SlotName     string `json:"slotName,omitempty"`
	Publication  string `json:"publication,omitempty"`
	// Tables are the (schema, table) pairs a capture reads, where the source's log holds every table (binlog).
	Tables   []CaptureTable `json:"tables,omitempty"`
	Position string         `json:"position,omitempty"`
	GapID    string         `json:"gapId,omitempty"`
	// Received is the spool record the cell has, with all before it (cdc.ack).
	Received string `json:"received,omitempty"`
	// MQTT is an mqtt capture's broker, topic filters and sealed login (cdc.start, method mqtt).
	MQTT *MQTTCapture `json:"mqtt,omitempty"`
	// OPCUA is an opcua capture's server and the nodes it monitors (cdc.start, method opcua).
	OPCUA *OPCUACapture `json:"opcua,omitempty"`
	// Entries are a connection's whole signed allow-list (allowlist); none ends it.
	Entries []SignedEntry `json:"entries,omitempty"`
}

// OPCUACapture is what an opcua capture monitors (spec 20.3): the server, reached as a read
// reaches it (its key and login sealed for the capture, the slot being the work), and per
// streamed object the instances under its root and the variables at its fields' browse paths,
// sampled as the manifest declares. Values go up as the server publishes them, never spooled.
type OPCUACapture struct {
	OPCUAServer
	Objects []OPCUAMonitored `json:"objects"`
}

// OPCUAMonitored is one streamed object's monitored items.
type OPCUAMonitored struct {
	Object         string   `json:"object"`
	Root           string   `json:"root"`
	TypeDefinition string   `json:"typeDefinition,omitempty"`
	Paths          []string `json:"paths"`
	// SamplingMs is the sampling interval asked of the server; 0 is as fast as it samples.
	SamplingMs float64 `json:"samplingMs"`
	QueueSize  uint32  `json:"queueSize"`
	// Deadband filters out changes smaller than an absolute amount or a percent of the range.
	Deadband *OPCUADeadband `json:"deadband,omitempty"`
}

// OPCUADeadband is a data change filter's deadband: absolute or percent.
type OPCUADeadband struct {
	Type  string  `json:"type"`
	Value float64 `json:"value"`
}

// Samples carries OPC UA values up an opcua capture stream: the object, the instance (browse
// name and node), the browse path, the value, the source's and server's timestamps and the
// value's status (good, uncertain or bad).
type Samples struct {
	Type    string           `json:"type"`
	Samples []map[string]any `json:"samples"`
}

// MQTTCapture is what an mqtt capture subscribes to (spec 20.2, 20.6): the messages go up as
// they arrive and are never spooled.
type MQTTCapture struct {
	EndpointURL string       `json:"endpointUrl"`
	Topics      []MQTTTopic  `json:"topics"`
	Credential  *SealedLogin `json:"credential"`
}

// Messages carries MQTT messages up an mqtt capture stream: topic, payload (base64), whether
// retained, and when the agent received each.
type Messages struct {
	Type     string           `json:"type"`
	Messages []map[string]any `json:"messages"`
}

// Statement is a generated statement: text with placeholders, and its values in order.
type Statement struct {
	Text   string `json:"text"`
	Values []any  `json:"values"`
}

// SQLRead is the payload of sql.read work.
type SQLRead struct {
	ConnectionID string       `json:"connectionId"`
	Dialect      string       `json:"dialect"`
	Statement    Statement    `json:"statement"`
	MaxRows      int          `json:"maxRows"`
	Credential   *SealedLogin `json:"credential"`
}

// MQTTSnapshot is the payload of mqtt.snapshot work (spec 20.2): the retained messages on the
// topic filters, gathered for a window, as the backfill of what the broker holds (18.5).
type MQTTSnapshot struct {
	ConnectionID string `json:"connectionId"`
	// EndpointURL is the broker as the agent reaches it: tcp:// or ssl:// (mqtt:// and mqtts:// read the same).
	EndpointURL string       `json:"endpointUrl"`
	Topics      []MQTTTopic  `json:"topics"`
	WindowMs    int          `json:"windowMs"`
	MaxMessages int          `json:"maxMessages"`
	Credential  *SealedLogin `json:"credential"`
}

// FilesList and FilesRead are the payloads of files.list and files.read work (spec 14.4, 10.4):
// a file share's directory, under the root the manifest names, its regular files listed, or one
// of them read up to MaxBytes, in chunks.
type FilesList struct {
	ConnectionID string `json:"connectionId"`
	Root         string `json:"root"`
	Directory    string `json:"directory"`
}

type FilesRead struct {
	FilesList
	Name     string `json:"name"`
	MaxBytes int64  `json:"maxBytes"`
}

// SFTPRequest is the payload of sftp.list and sftp.read work (spec 14.4): a server on the
// customer's network, pinned by its host key's SHA-256 as OpenSSH prints it, its login sealed
// for this work; a directory under the base path listed, or one file read up to MaxBytes.
type SFTPRequest struct {
	ConnectionID  string       `json:"connectionId"`
	Host          string       `json:"host"`
	Port          int          `json:"port"`
	BasePath      string       `json:"basePath"`
	HostKeySHA256 string       `json:"hostKeySha256"`
	Directory     string       `json:"directory"`
	Name          string       `json:"name,omitempty"`
	MaxBytes      int64        `json:"maxBytes,omitempty"`
	Credential    *SealedLogin `json:"credential"`
}

// File share refusals (source_refused): the path is not there, or the host does not let the agent read it.
const (
	RefusedNotFound   = "not_found"
	RefusedPermission = "permission"
)

// OPCUARead is the payload of opcua.read work (spec 20.3): the instances under a root node (its
// child objects, of a type definition where one is named), and for each the values at the
// manifest's browse paths. Nodes are named by namespace URI, never by index.
type OPCUARead struct {
	OPCUAServer
	Root           string   `json:"root"`
	TypeDefinition string   `json:"typeDefinition,omitempty"`
	Paths          []string `json:"paths"`
	MaxInstances   int      `json:"maxInstances"`
}

// OPCUAServer is how the agent reaches an OPC UA server (spec 20.3): the endpoint, its security
// ("None", or a policy and mode such as "Basic256Sha256 SignAndEncrypt"), and for a signed
// policy the server certificate the owner pinned and the endpoint's application instance
// certificate, whose key the cell seals for this work.
type OPCUAServer struct {
	ConnectionID string `json:"connectionId"`
	// EndpointURL is the server as the agent reaches it: opc.tcp://host:port/path.
	EndpointURL    string `json:"endpointUrl"`
	SecurityPolicy string `json:"securityPolicy"`
	// ServerThumbprint is the server certificate's SHA-1 (40 hex) or SHA-256 (64 hex).
	ServerThumbprint string `json:"serverThumbprint,omitempty"`
	// Certificate is the application instance certificate, DER, base64.
	Certificate    string       `json:"certificate,omitempty"`
	ApplicationKey *SealedLogin `json:"applicationKey,omitempty"`
	Credential     *SealedLogin `json:"credential"`
}

// OPCUAProbe is the payload of opcua.probe work: connect as a read would and report the
// server's namespaces, so the owner knows the server trusts the application certificate.
type OPCUAProbe struct {
	OPCUAServer
}

// MQTTTopic is one topic filter (+ and # wildcards) and the QoS it is subscribed at.
type MQTTTopic struct {
	Filter string `json:"filter"`
	QoS    byte   `json:"qos"`
}

// Result frames go up a work stream, ending with done or error.
type Pong struct {
	Type    string `json:"type"`
	Version string `json:"version"`
}

type Rows struct {
	Type string           `json:"type"`
	Rows []map[string]any `json:"rows"`
}

type Done struct {
	Type      string `json:"type"`
	RowCount  int    `json:"rowCount"`
	Truncated bool   `json:"truncated"`
	RowCounts []int  `json:"rowCounts,omitempty"`
}

// Error categories the cell accepts. NotConfigured and Capacity are a capture stream's only.
const (
	SourceUnreachable = "source_unreachable"
	Timeout           = "timeout"
	Bounds            = "bounds"
	Integrity         = "integrity"
	SourceRefused     = "source_refused"
	Internal          = "internal"
	NotConfigured     = "not_configured"
	// SourceNotConfigured: the source does not log what change capture needs; the agent's log names the setting.
	SourceNotConfigured = "source_not_configured"
	Capacity            = "capacity"
	GrantRefused        = "grant_refused"
	RowCountMismatch    = "row_count_mismatch"
	// LoginRefused: the login the cell sealed for this work was not taken (spec 10.7); Reason says why.
	LoginRefused = "login_refused"
	// TargetRefused: the host's owner does not let the cell send this agent there (configuration targets).
	TargetRefused = "target_refused"
	// ActuationRefused: a physical webhook this agent's signed allow-list does not let it send now (47.4, 47.5);
	// Reason is not_listed, kind, interval or rate.
	ActuationRefused = "actuation_refused"
)

// Reasons a source_refused error gives (industrial plugins): the server refused the login, does
// not trust the application certificate, presented a certificate other than the one pinned, or
// offers no endpoint with the security asked for.
const (
	RefusedLogin             = "login"
	RefusedUntrusted         = "untrusted"
	RefusedServerCertificate = "server_certificate"
	RefusedPolicy            = "policy"
)

// CaptureTable is one table a capture reads.
type CaptureTable struct {
	Schema string `json:"schema"`
	Table  string `json:"table"`
}

// SealedLogin is a connection's login the cell sealed to this agent for one piece of work
// (spec 10.7): HPKE, base64, and when it stops being taken.
type SealedLogin struct {
	Sealed    string    `json:"sealed"`
	ExpiresAt time.Time `json:"expiresAt"`
}

type workIDKey struct{}

// WithWorkID carries the piece of work's id to its handler: a sealed login is bound to it.
func WithWorkID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, workIDKey{}, id)
}

// WorkID is the id of the piece of work ctx runs.
func WorkID(ctx context.Context) string {
	id, _ := ctx.Value(workIDKey{}).(string)
	return id
}

// Note is a capture stream frame with nothing but its type: started, lost, dropped.
type Note struct {
	Type string `json:"type"`
}

// Gap is what the spool dropped, or a resumed reader found missing: counts and a time range,
// or positions, never values.
type Gap struct {
	Type         string     `json:"type"`
	ID           string     `json:"id"`
	Reason       string     `json:"reason"`
	Records      *int       `json:"records,omitempty"`
	Changes      *int       `json:"changes,omitempty"`
	From         *time.Time `json:"from,omitempty"`
	To           *time.Time `json:"to,omitempty"`
	FromPosition string     `json:"fromPosition,omitempty"`
	ToPosition   string     `json:"toPosition,omitempty"`
}

// Marshal is one frame's JSON, without the newline.
func Marshal(frame any) ([]byte, error) { return json.Marshal(frame) }

type Error struct {
	Type     string `json:"type"`
	Category string `json:"category"`
	// SQLState is the source's code, never its message text.
	SQLState string `json:"sqlstate,omitempty"`
	// Reason says why a write's grant was refused (grant_refused).
	Reason string `json:"reason,omitempty"`
	// Index and Rows say which statement changed how many rows (row_count_mismatch).
	Index *int `json:"index,omitempty"`
	Rows  *int `json:"rows,omitempty"`
}

func NewHeartbeat(version string, activeCalls int, cdcSlots, cdcSpooled []string, discoveryDisabled bool) Heartbeat {
	return Heartbeat{Type: "heartbeat", Version: version, ActiveCalls: activeCalls, CDCReaders: len(cdcSlots), DiscoveryDisabled: discoveryDisabled,
		CDCSlots: cdcSlots, CDCSpooled: cdcSpooled}
}

func NewPong(version string) Pong        { return Pong{Type: "pong", Version: version} }
func NewRows(rows []map[string]any) Rows { return Rows{Type: "rows", Rows: rows} }
func NewDone(rowCount int, truncated bool) Done {
	return Done{Type: "done", RowCount: rowCount, Truncated: truncated}
}
func NewError(category, sqlstate string) Error {
	return Error{Type: "error", Category: category, SQLState: sqlstate}
}

// Writer writes frames, one JSON object per line.
type Writer struct {
	w   io.Writer
	enc *json.Encoder
}

func NewWriter(w io.Writer) *Writer { return &Writer{w: w, enc: json.NewEncoder(w)} }

// Write encodes one frame and its newline.
func (fw *Writer) Write(frame any) error { return fw.enc.Encode(frame) }

// Reader reads frames, one JSON object per line, refusing a line over MaxFrameBytes.
type Reader struct{ scanner *bufio.Scanner }

func NewReader(r io.Reader) *Reader {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 64*1024), MaxFrameBytes)
	return &Reader{scanner: scanner}
}

// Next decodes the next non-empty line into frame; io.EOF at the end.
func (fr *Reader) Next(frame any) error {
	for fr.scanner.Scan() {
		line := fr.scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		if err := json.Unmarshal(line, frame); err != nil {
			return fmt.Errorf("a frame is not JSON: %w", err)
		}
		return nil
	}
	if err := fr.scanner.Err(); err != nil {
		return err
	}
	return io.EOF
}
