package update

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type signer struct {
	key ed25519.PrivateKey
	id  string
	b64 string
}

func newSigner(t *testing.T) signer {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, _ := x509.MarshalPKIXPublicKey(pub)
	sum := sha256.Sum256(der)
	return signer{key: priv, id: base64.RawURLEncoding.EncodeToString(sum[:]), b64: base64.StdEncoding.EncodeToString(der)}
}

func (s signer) sign(prefix, text string) Signature {
	sig := ed25519.Sign(s.key, append(append([]byte(prefix), 0), text...))
	return Signature{KeyID: s.id, Role: "release", Signature: base64.RawURLEncoding.EncodeToString(sig)}
}

const binDigest = "sha256:" + "ab" + "0000000000000000000000000000000000000000000000000000000000cd"

func manifestText(releaseID, target, version string) string {
	return fmt.Sprintf(`{"agentBinaries":[{"digest":"%s","platform":"linux_x86_64","sbom":{"digest":"%s","format":"cyclonedx"},"version":"%s"}],"releaseId":"%s","schema":"silo.release.v1","target":"%s"}`,
		binDigest, binDigest, version, releaseID, target)
}

func headText(channel, releaseID, manifest string) string {
	sum := sha256.Sum256([]byte(manifest))
	return fmt.Sprintf(`{"channel":"%s","manifestDigest":"sha256:%s","promotedAt":"2026-11-17T09:00:00.000Z","promotionId":"0190f4a8-0000-7000-8000-000000000001","releaseId":"%s","schema":"silo.channel.v1","sequence":3}`,
		channel, hex.EncodeToString(sum[:]), releaseID)
}

func offer(s signer, channel, target, version string) Offer {
	m := manifestText("r-2026.11.17", target, version)
	h := headText(channel, "r-2026.11.17", m)
	return Offer{
		Action: "update", Version: version, Platform: "linux_x86_64", Digest: binDigest, Bytes: 1024,
		Head:    Signed{Text: h, Signatures: []Signature{s.sign(ChannelPrefix, h)}},
		Release: Signed{Text: m, Signatures: []Signature{s.sign(ReleasePrefix, m)}},
	}
}

var want = Want{Channel: "agent-stable", Target: "commercial", Platform: "linux_x86_64", Running: "1.2.0"}

func TestCheck(t *testing.T) {
	s := newSigner(t)
	keys, err := ParseKeys(s.b64 + ", ")
	if err != nil || len(keys) != 1 {
		t.Fatalf("keys: %v %d", err, len(keys))
	}
	good := offer(s, "agent-stable", "commercial", "1.3.0")
	if r := Check(good, keys, want); r != "" {
		t.Fatalf("a good release refused: %s", r)
	}
	cases := map[string]struct {
		change func(o *Offer, w *Want, k *Keys)
		reason string
	}{
		"no keys built in": {func(_ *Offer, _ *Want, k *Keys) { *k = Keys{} }, RefusedNoKey},
		"manifest altered": {func(o *Offer, _ *Want, _ *Keys) {
			o.Release.Text = strings.Replace(o.Release.Text, "1.3.0", "1.3.1", 1)
		}, RefusedSignature},
		"head altered": {func(o *Offer, _ *Want, _ *Keys) {
			o.Head.Text = strings.Replace(o.Head.Text, `"sequence":3`, `"sequence":4`, 1)
		}, RefusedSignature},
		"signed by another key": {func(o *Offer, _ *Want, _ *Keys) {
			o.Release = offer(newSigner(t), "agent-stable", "commercial", "1.3.0").Release
		}, RefusedSignature},
		"a bad signature by a known key beside a good one": {func(o *Offer, _ *Want, _ *Keys) {
			bad := o.Release.Signatures[0]
			bad.Signature = o.Head.Signatures[0].Signature
			o.Release.Signatures = append(o.Release.Signatures, bad)
		}, RefusedSignature},
		"a sovereign role only": {func(o *Offer, _ *Want, _ *Keys) { o.Release.Signatures[0].Role = "sovereign" }, RefusedSignature},
		"not on the agent channel": {func(o *Offer, _ *Want, _ *Keys) {
			*o = offer(s, "stable", "commercial", "1.3.0")
		}, RefusedNotPromoted},
		"the head names another manifest": {func(o *Offer, _ *Want, _ *Keys) {
			other := manifestText("r-2026.11.17", "commercial", "1.4.0")
			h := headText("agent-stable", "r-2026.11.17", other)
			o.Head = Signed{Text: h, Signatures: []Signature{s.sign(ChannelPrefix, h)}}
		}, RefusedNotPromoted},
		"a sovereign build":       {func(o *Offer, _ *Want, _ *Keys) { *o = offer(s, "agent-stable", "sovereign", "1.3.0") }, RefusedTarget},
		"another platform":        {func(_ *Offer, w *Want, _ *Keys) { w.Platform = "linux_arm64" }, RefusedPlatform},
		"another digest offered":  {func(o *Offer, _ *Want, _ *Keys) { o.Digest = "sha256:" + strings.Repeat("0", 64) }, RefusedPlatform},
		"another version offered": {func(o *Offer, _ *Want, _ *Keys) { o.Version = "1.9.0" }, RefusedPlatform},
		"not newer":               {func(_ *Offer, w *Want, _ *Keys) { w.Running = "1.3.0" }, RefusedNotNewer},
		"older":                   {func(_ *Offer, w *Want, _ *Keys) { w.Running = "2.0.0" }, RefusedNotNewer},
		"failed here before":      {func(_ *Offer, w *Want, _ *Keys) { w.Failed = []string{"1.3.0"} }, RefusedFailedBefore},
	}
	for name, c := range cases {
		o := offer(s, "agent-stable", "commercial", "1.3.0")
		w := want
		k := keys
		c.change(&o, &w, &k)
		if r := Check(o, k, w); r != c.reason {
			t.Errorf("%s: got %q, want %q", name, r, c.reason)
		}
	}
}

func TestParseKeysRefusesOthers(t *testing.T) {
	if _, err := ParseKeys("not base64!"); err == nil {
		t.Fatal("garbage parsed")
	}
	if keys, err := ParseKeys(""); err != nil || len(keys) != 0 {
		t.Fatal("an empty list is no keys")
	}
}

func TestCompare(t *testing.T) {
	ordered := []string{"0.9.9", "1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.0.1", "1.2.0", "1.10.0", "2.0.0"}
	for i := range ordered {
		for j := range ordered {
			got := Compare(ordered[i], ordered[j])
			if (i < j && got >= 0) || (i > j && got <= 0) || (i == j && got != 0) {
				t.Errorf("Compare(%s, %s) = %d", ordered[i], ordered[j], got)
			}
		}
	}
	if Compare("1.2.3+build.5", "1.2.3") != 0 {
		t.Error("build metadata is not ordered")
	}
}

func TestReceiveKeepsOnlyTheBytesOffered(t *testing.T) {
	dir := t.TempDir()
	body := []byte("#!/bin/sh\necho agent\n")
	sum := sha256.Sum256(body)
	o := Offer{Version: "1.3.0", Digest: "sha256:" + hex.EncodeToString(sum[:]), Bytes: int64(len(body))}

	if _, err := Receive(dir, Offer{Version: o.Version, Digest: o.Digest, Bytes: o.Bytes}, strings.NewReader("#!/bin/sh\necho other\n")); err != ErrDigest {
		t.Fatalf("other bytes: %v", err)
	}
	if _, err := Receive(dir, o, strings.NewReader(string(body)+"more")); err != ErrDigest {
		t.Fatalf("more bytes: %v", err)
	}
	if _, err := Receive(dir, o, strings.NewReader(string(body[:5]))); err != ErrDigest {
		t.Fatalf("fewer bytes: %v", err)
	}
	entries, _ := os.ReadDir(filepath.Join(dir, "bin"))
	if len(entries) != 0 {
		t.Fatalf("a refused download left %d files", len(entries))
	}
	e, err := Receive(dir, o, strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	if !Intact(dir, e) {
		t.Fatal("the binary kept is not intact")
	}
	info, _ := os.Stat(Path(dir, e))
	if info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("the binary is open to others: %v", info.Mode())
	}
	os.WriteFile(Path(dir, e), []byte("tampered"), 0o700)
	if Intact(dir, e) {
		t.Fatal("a damaged binary passed as intact")
	}
}

func TestStateTakesAndGoesBack(t *testing.T) {
	dir := t.TempDir()
	var s State
	if s.Back("x") {
		t.Fatal("went back from the installed binary")
	}
	a := &Entry{Version: "1.3.0", Digest: "sha256:a", File: FileName("1.3.0")}
	b := &Entry{Version: "1.4.0", Digest: "sha256:b", File: FileName("1.4.0")}
	s.Take(a)
	s.Take(b)
	if s.Current != b || s.Previous != a {
		t.Fatal("the update and the binary before are not kept")
	}
	for _, name := range []string{a.File, b.File, FileName("1.2.0"), "state.json"} {
		os.MkdirAll(filepath.Join(dir, "bin"), 0o700)
		os.WriteFile(filepath.Join(dir, "bin", name), []byte(name), 0o700)
	}
	if err := Save(dir, s); err != nil {
		t.Fatal(err)
	}
	Prune(dir, s)
	if _, err := os.Stat(filepath.Join(dir, "bin", FileName("1.2.0"))); !os.IsNotExist(err) {
		t.Fatal("a binary no longer named was kept")
	}
	if !s.Back(RefusedFailedStart) || s.Current.Version != "1.3.0" || s.Previous != nil {
		t.Fatal("did not go back to the binary before")
	}
	if len(s.Failed) != 1 || s.Failed[0] != "1.4.0" || len(s.Pending) != 1 || s.Pending[0].Reason != RefusedFailedStart {
		t.Fatalf("the failure is not remembered: %+v", s)
	}
	if err := Save(dir, s); err != nil {
		t.Fatal(err)
	}
	loaded, err := Load(dir)
	if err != nil || loaded.Current.Version != "1.3.0" || loaded.Failed[0] != "1.4.0" {
		t.Fatalf("state did not survive: %v %+v", err, loaded)
	}
	if !loaded.Back("") || loaded.Current != nil {
		t.Fatal("did not go back to the installed binary")
	}
}

// The test binary stands in for an agent: run as a child, it exits as told.
func TestMain(m *testing.M) {
	if code := os.Getenv("UPDATE_TEST_EXIT"); code != "" {
		if os.Getenv(ChildEnv) != "1" || os.Getenv(BaseVersionEnv) != "1.2.0" {
			os.Exit(3)
		}
		if code == "wait" {
			WatchLauncher(func() { os.Exit(0) })
			time.Sleep(time.Minute)
			os.Exit(4)
		}
		var n int
		fmt.Sscan(code, &n)
		os.Exit(n)
	}
	os.Exit(m.Run())
}

func TestRunChild(t *testing.T) {
	self, _ := os.Executable()
	for _, code := range []int{0, 1, RestartCode} {
		t.Setenv("UPDATE_TEST_EXIT", fmt.Sprint(code))
		got, err := RunChild(context.Background(), self, nil, "1.2.0")
		if err != nil || got != code {
			t.Fatalf("exit %d: got %d, %v", code, got, err)
		}
	}
	// Stopped by its launcher: asked to stop, it goes.
	t.Setenv("UPDATE_TEST_EXIT", "wait")
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	started := time.Now()
	if _, err := RunChild(ctx, self, nil, "1.2.0"); err != nil {
		t.Fatal(err)
	}
	if time.Since(started) > 20*time.Second {
		t.Fatal("the child outlived its launcher's stop")
	}
}

// A sovereign build (spec 11.1, 11.4): the release is Silo's, signed by the release key; the head
// on agent-sovereign is the sovereign fleet-control's, signed by the sovereign key once cleared
// staff countersigned the bundle that brought the release in. Both, or no update.
func TestCheckSovereign(t *testing.T) {
	silo, sovereign := newSigner(t), newSigner(t)
	releaseKeys, _ := ParseKeys(silo.b64)
	sovereignKeys, _ := ParseKeys(sovereign.b64)
	sovereignWant := Want{Channel: "agent-sovereign", Target: "sovereign", SovereignKeys: sovereignKeys, Platform: "linux_x86_64", Running: "1.2.0"}
	countersigned := func() Offer {
		o := offer(silo, "agent-sovereign", "sovereign", "1.3.0")
		sig := sovereign.sign(ChannelPrefix, o.Head.Text)
		sig.Role = "sovereign"
		o.Head.Signatures = []Signature{sig}
		return o
	}
	if r := Check(countersigned(), releaseKeys, sovereignWant); r != "" {
		t.Fatalf("a countersigned sovereign release refused: %s", r)
	}
	if r := Check(offer(silo, "agent-sovereign", "sovereign", "1.3.0"), releaseKeys, sovereignWant); r != RefusedSignature {
		t.Fatalf("a head the sovereign key did not sign: %s", r)
	}
	noSovereign := sovereignWant
	noSovereign.SovereignKeys = Keys{}
	if r := Check(countersigned(), releaseKeys, noSovereign); r != RefusedNoKey {
		t.Fatalf("a sovereign build without its sovereign key takes nothing: %s", r)
	}
	sovereignOnly := countersigned()
	sovereignOnly.Release.Signatures = []Signature{sovereign.sign(ReleasePrefix, sovereignOnly.Release.Text)}
	if r := Check(sovereignOnly, releaseKeys, sovereignWant); r != RefusedSignature {
		t.Fatalf("a release without Silo's signature: %s", r)
	}
	if r := Check(countersigned(), releaseKeys, want); r != RefusedSignature {
		t.Fatalf("a commercial build never takes the agent-sovereign head: %s", r)
	}
}
