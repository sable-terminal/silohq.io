package main

import (
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Spec 19: discovery is compiled out of the sovereign build entirely. The sovereign binary
// carries none of its code; the commercial one does.
func TestTheSovereignBuildHasNoDiscovery(t *testing.T) {
	if testing.Short() {
		t.Skip("builds the agent twice")
	}
	dir := t.TempDir()
	symbols := func(tags ...string) string {
		t.Helper()
		binary := filepath.Join(dir, "silo-agent-"+strings.Join(append(tags, "commercial"), "-"))
		args := append([]string{"build", "-o", binary}, func() []string {
			if len(tags) == 0 {
				return nil
			}
			return []string{"-tags", strings.Join(tags, ",")}
		}()...)
		build := exec.Command("go", append(args, ".")...)
		build.Env = append(build.Environ(), "CGO_ENABLED=0")
		if out, err := build.CombinedOutput(); err != nil {
			t.Fatalf("build %v: %v\n%s", tags, err, out)
		}
		out, err := exec.Command("go", "tool", "nm", binary).Output()
		if err != nil {
			t.Fatal(err)
		}
		return string(out)
	}
	if !strings.Contains(symbols(), "silohq.io/agent/internal/discovery.") {
		t.Fatal("the commercial build carries discovery")
	}
	if strings.Contains(symbols("sovereign"), "silohq.io/agent/internal/discovery.") {
		t.Fatal("the sovereign build carries discovery code")
	}
}
