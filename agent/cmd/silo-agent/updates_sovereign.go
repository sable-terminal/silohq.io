//go:build sovereign

package main

// The sovereign build updates from agent-sovereign (spec 11.1, 11.4): its releases reach the
// sovereign cell only as bundles UK cleared staff reviewed and countersigned, loaded into the
// sovereign fleet-control, which then promotes them. It takes an update only when the release
// carries the Silo release key's signature and the head the sovereign release key's: both built
// in, -ldflags "-X main.ReleaseKeys=... -X main.SovereignKeys=...". Without both it takes none.
var ReleaseKeys = ""

// SovereignKeys are the sovereign release keys this build trusts for the agent-sovereign head.
var SovereignKeys = ""

const (
	updatesBuilt  = true
	updateChannel = "agent-sovereign"
	updateTarget  = "sovereign"
)
