package discovery

import (
	"strings"
	"time"
	"unicode/utf8"

	"silohq.io/agent/internal/protocol"
)

// What a scan reports up its work stream, as the cell reads it (scanEvent in
// app/server/src/contracts/discovery/scan.contract.ts). A change here is a change there.

// Probe outcomes. Open: a connection was taken. Identified: what answered was recognised.
// Closed: nothing answered (refused or silent). Refused: it answered and turned the agent's
// credentials away. Error: anything else.
const (
	Open       = "open"
	Identified = "identified"
	Closed     = "closed"
	Refused    = "refused"
	Error      = "error"
)

// Probe is one contact: what, when, how it went. Every one is reported (spec 19.3).
type Probe struct {
	Type     string    `json:"type"`
	Host     string    `json:"host"`
	Port     *int      `json:"port"`
	Method   string    `json:"method"`
	Outcome  string    `json:"outcome"`
	ProbedAt time.Time `json:"probedAt"`
}

// Finding is a system found, structure only.
type Finding struct {
	Type   string `json:"type"`
	Host   string `json:"host"`
	Method string `json:"method"`
	Found  Found  `json:"found"`
}

// End ends a scan: completed, or failed with a code. Unavailable names authorised methods this
// agent cannot carry out.
type End struct {
	Type        string   `json:"type"`
	Status      string   `json:"status"`
	Reason      string   `json:"reason,omitempty"`
	Unavailable []string `json:"unavailable,omitempty"`
}

// Found is spec 19.3's structure: product, version, schemas, tables, columns, types, keys and
// row counts, node classes, topic names. Nothing here can hold a row.
type Found struct {
	Product     *string  `json:"product"`
	Version     *string  `json:"version"`
	Protocol    string   `json:"protocol"`
	Dialect     *string  `json:"dialect"`
	Port        *int     `json:"port"`
	Schemas     []Schema `json:"schemas"`
	NodeClasses []string `json:"nodeClasses"`
	Topics      []string `json:"topics"`
	// OPCUA and MQTT are an industrial finding's structure: types, variables and references; topic families and payload shapes.
	OPCUA *protocol.OPCUAStructure `json:"opcua,omitempty"`
	MQTT  *protocol.MQTTStructure  `json:"mqtt,omitempty"`
}

type Schema struct {
	Name   string  `json:"name"`
	Tables []Table `json:"tables"`
}

type Table struct {
	Name        string       `json:"name"`
	RowCount    *int64       `json:"rowCount"`
	Columns     []Column     `json:"columns"`
	PrimaryKey  []string     `json:"primaryKey"`
	UniqueKeys  [][]string   `json:"uniqueKeys"`
	ForeignKeys []ForeignKey `json:"foreignKeys"`
}

type Column struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Nullable bool   `json:"nullable"`
}

type ForeignKey struct {
	Columns       []string `json:"columns"`
	TargetSchema  *string  `json:"targetSchema"`
	TargetTable   string   `json:"targetTable"`
	TargetColumns []string `json:"targetColumns"`
}

// The cell's bounds on a finding (foundStructure).
const (
	maxSchemas    = 200
	maxTables     = 2_000
	maxColumns    = 2_000
	maxKeyColumns = 16
	maxUniqueKeys = 50
	maxForeign    = 200
	maxName       = 128
	maxTypeName   = 64
	maxProduct    = 100
	maxVersion    = 50
)

// text is s, printable and cut to limit bytes on a character boundary; nil when nothing is left.
func text(s string, limit int) *string {
	s = strings.TrimSpace(strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || r == utf8.RuneError {
			return -1
		}
		return r
	}, s))
	for len(s) > limit {
		_, size := utf8.DecodeLastRuneInString(s)
		s = s[:len(s)-size]
	}
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return &s
}

func intp(n int) *int { return &n }

// portp is a port, or nil where none is known.
func portp(port int) *int {
	if port < 1 || port > 65535 {
		return nil
	}
	return &port
}

// service is a finding for a system answering on a port: what it appears to be, no structure.
func service(port int, product, version, protocol, dialect string) Found {
	return Found{Product: text(product, maxProduct), Version: text(version, maxVersion), Protocol: protocol, Dialect: text(dialect, 32),
		Port: portp(port), Schemas: []Schema{}, NodeClasses: []string{}, Topics: []string{}}
}
