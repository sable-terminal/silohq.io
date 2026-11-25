//go:build !sovereign

package main

// ReleaseKeys are the Silo release keys this agent trusts for its own updates (spec 10.7):
// base64 SubjectPublicKeyInfo DER, comma separated, built in with
// -ldflags "-X main.ReleaseKeys=...". A build without them takes no update.
var ReleaseKeys = ""

// SovereignKeys are a sovereign build's; the commercial build trusts none.
var SovereignKeys = ""

// The commercial build updates from agent-stable (spec 11.2).
const (
	updatesBuilt  = true
	updateChannel = "agent-stable"
	updateTarget  = "commercial"
)
