package work

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"silohq.io/agent/internal/protocol"
)

// frames runs a handler and returns what it emitted.
func frames(t *testing.T, run func(context.Context, json.RawMessage, Emit) error, payload any) []map[string]any {
	t.Helper()
	raw, _ := json.Marshal(payload)
	var out []map[string]any
	err := run(context.Background(), raw, func(frame any) error {
		b, _ := json.Marshal(frame)
		var m map[string]any
		_ = json.Unmarshal(b, &m)
		out = append(out, m)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func share(t *testing.T) (allowed, outside string) {
	t.Helper()
	base := t.TempDir()
	allowed = filepath.Join(base, "share")
	outside = filepath.Join(base, "private")
	for _, dir := range []string{filepath.Join(allowed, "exports", "nested"), outside} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(path, content string) {
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(allowed, "exports", "orders-1.csv"), "id,region\n1,north\n")
	write(filepath.Join(allowed, "exports", "orders-2.csv"), "id,region\n2,south\n")
	write(filepath.Join(outside, "secret.csv"), "token\nxyz\n")
	// A link inside the share that points outside it, and one to a file within it.
	if err := os.Symlink(filepath.Join(outside, "secret.csv"), filepath.Join(allowed, "exports", "escape.csv")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(allowed, "exports", "orders-1.csv"), filepath.Join(allowed, "exports", "alias.csv")); err != nil {
		t.Fatal(err)
	}
	return allowed, outside
}

func TestFilesListsRegularFilesBeneathAnAllowedRootOnly(t *testing.T) {
	allowed, outside := share(t)
	files := NewFiles([]string{allowed})
	got := frames(t, files.List, protocol.FilesList{ConnectionID: "c", Root: allowed, Directory: "exports"})
	names := map[string]bool{}
	for _, row := range got[0]["rows"].([]any) {
		names[row.(map[string]any)["name"].(string)] = true
	}
	if len(names) != 3 || !names["orders-1.csv"] || !names["orders-2.csv"] || !names["alias.csv"] {
		t.Fatalf("listed %v: regular files and a link within the share, not the nested directory or the link leaving it", names)
	}
	if got[len(got)-1]["type"] != "done" {
		t.Fatalf("ends with done: %v", got)
	}
	// A root outside every allowed one, a path climbing out, and no roots at all: refused.
	for _, payload := range []protocol.FilesList{{Root: outside, Directory: "."}, {Root: allowed, Directory: "../private"}, {Root: allowed, Directory: "exports/.."}} {
		out := frames(t, files.List, payload)
		if out[0]["type"] != "error" {
			t.Fatalf("%+v was not refused: %v", payload, out)
		}
	}
	if out := frames(t, files.List, protocol.FilesList{Root: outside, Directory: "x"}); out[0]["category"] != protocol.TargetRefused {
		t.Fatalf("outside the roots: %v", out)
	}
	if out := frames(t, NewFiles(nil).List, protocol.FilesList{Root: allowed, Directory: "exports"}); out[0]["category"] != protocol.TargetRefused {
		t.Fatalf("no roots configured reads nothing: %v", out)
	}
	if out := frames(t, files.List, protocol.FilesList{Root: allowed, Directory: "missing"}); out[0]["category"] != protocol.SourceRefused || out[0]["reason"] != protocol.RefusedNotFound {
		t.Fatalf("a missing directory is named so: %v", out)
	}
}

func TestFilesReadsInChunksWithinTheBoundAndNeverThroughALinkOut(t *testing.T) {
	allowed, _ := share(t)
	files := NewFiles([]string{allowed})
	big := bytes.Repeat([]byte("0123456789abcdef"), (FileChunk/16)+100)
	if err := os.WriteFile(filepath.Join(allowed, "exports", "big.jsonl"), big, 0o644); err != nil {
		t.Fatal(err)
	}
	got := frames(t, files.Read, protocol.FilesRead{FilesList: protocol.FilesList{Root: allowed, Directory: "exports"}, Name: "big.jsonl", MaxBytes: int64(len(big))})
	var joined []byte
	var offsets []float64
	for _, frame := range got[:len(got)-1] {
		row := frame["rows"].([]any)[0].(map[string]any)
		offsets = append(offsets, row["offset"].(float64))
		chunk, _ := base64.StdEncoding.DecodeString(row["data"].(string))
		joined = append(joined, chunk...)
	}
	if !bytes.Equal(joined, big) || len(offsets) != 2 || offsets[1] != FileChunk {
		t.Fatalf("read %d bytes in %d chunks at %v", len(joined), len(offsets), offsets)
	}
	if out := frames(t, files.Read, protocol.FilesRead{FilesList: protocol.FilesList{Root: allowed, Directory: "exports"}, Name: "big.jsonl", MaxBytes: 10}); out[0]["category"] != protocol.Bounds {
		t.Fatalf("a file over the bound is refused, never cut: %v", out)
	}
	if out := frames(t, files.Read, protocol.FilesRead{FilesList: protocol.FilesList{Root: allowed, Directory: "exports"}, Name: "escape.csv", MaxBytes: 1000}); out[0]["category"] != protocol.TargetRefused {
		t.Fatalf("a link leaving the share is refused: %v", out)
	}
	if out := frames(t, files.Read, protocol.FilesRead{FilesList: protocol.FilesList{Root: allowed, Directory: "exports"}, Name: "nested", MaxBytes: 1000}); out[0]["type"] != "error" {
		t.Fatalf("a directory is not read as a file: %v", out)
	}
	alias := frames(t, files.Read, protocol.FilesRead{FilesList: protocol.FilesList{Root: allowed, Directory: "exports"}, Name: "alias.csv", MaxBytes: 1000})
	data, _ := base64.StdEncoding.DecodeString(alias[0]["rows"].([]any)[0].(map[string]any)["data"].(string))
	if string(data) != "id,region\n1,north\n" {
		t.Fatalf("a link within the share is read: %q", data)
	}
}
