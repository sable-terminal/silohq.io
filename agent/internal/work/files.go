// Files (spec 14.4 "SFTP and file share", 10.4): a file share on the customer's network, read
// from this host's own file system, a share mounted here among them. The cell parses; the agent
// only lists and reads.
//
// Only beneath the roots the host's owner allows (configuration fileRoots): the manifest's root,
// the source's directory and the file's name are joined, every link resolved, and the result must
// lie within one allowed root, or the work is refused (target_refused), whatever the cell asks;
// with no roots configured nothing is read. A directory lists its regular files only (name, size,
// modification time), never what lies below it; a file is read only if it is regular and no
// larger than the bound, in chunks that each fit a frame. A path that is not there, or that the
// host does not let this process read, is refused with which (source_refused); never its contents.
package work

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"time"

	"silohq.io/agent/internal/protocol"
)

// FileChunk is the bytes a rows frame carries of a file: within the cell's 4 MiB frame once base64.
const FileChunk = 2 << 20

// MaxFileEntries bounds a listing, as the cell's SFTP listing is bounded.
const MaxFileEntries = 10_000

// Files lists and reads beneath the roots the host allows.
type Files struct {
	roots []string
	// given are the roots as the owner wrote them, for telling a missing path from a refused one.
	given []string
}

// NewFiles takes the configured roots, each resolved through its links once at start; a root that
// is not there is kept as given, so it is never matched until it exists as the owner wrote it.
func NewFiles(roots []string) *Files {
	resolved := make([]string, 0, len(roots))
	for _, root := range roots {
		if r, err := filepath.EvalSymlinks(filepath.Clean(root)); err == nil {
			resolved = append(resolved, r)
		} else {
			resolved = append(resolved, filepath.Clean(root))
		}
	}
	given := make([]string, 0, len(roots))
	for _, root := range roots {
		given = append(given, filepath.Clean(root))
	}
	return &Files{roots: resolved, given: given}
}

// within reports whether path lies at or beneath root.
func within(root, path string) bool {
	if path == root {
		return true
	}
	return strings.HasPrefix(path, strings.TrimSuffix(root, string(filepath.Separator))+string(filepath.Separator))
}

// segment is one relative name: never empty, ".", "..", absolute, or carrying a separator of another system.
func segments(rel string) bool {
	if rel == "" || filepath.IsAbs(rel) || strings.Contains(rel, "\\") {
		return false
	}
	for _, part := range strings.Split(rel, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

// resolve joins the share's root and the relative parts, resolves every link, and returns the
// path only if it lies within an allowed root; the error says which refusal it is.
func (f *Files) resolve(root string, rel ...string) (string, *protocol.Error) {
	if !filepath.IsAbs(root) || len(f.roots) == 0 {
		e := protocol.NewError(protocol.TargetRefused, "")
		return "", &e
	}
	for _, r := range rel {
		if !segments(r) {
			e := protocol.NewError(protocol.Integrity, "")
			return "", &e
		}
	}
	joined := filepath.Join(append([]string{filepath.Clean(root)}, filepath.FromSlash(strings.Join(rel, "/")))...)
	// The lexical path first: a root outside every allowed one is refused before the host is touched.
	allowedLexically := false
	for _, allowed := range append(append([]string{}, f.roots...), f.given...) {
		if within(allowed, joined) {
			allowedLexically = true
		}
	}
	real, err := filepath.EvalSymlinks(joined)
	if err != nil {
		if !allowedLexically {
			e := protocol.NewError(protocol.TargetRefused, "")
			return "", &e
		}
		return "", refusalOf(err)
	}
	for _, allowed := range f.roots {
		if within(allowed, real) {
			return real, nil
		}
	}
	e := protocol.NewError(protocol.TargetRefused, "")
	return "", &e
}

func refusalOf(err error) *protocol.Error {
	e := protocol.NewError(protocol.SourceRefused, "")
	switch {
	case errors.Is(err, fs.ErrNotExist):
		e.Reason = protocol.RefusedNotFound
	case errors.Is(err, fs.ErrPermission):
		e.Reason = protocol.RefusedPermission
	default:
		e = protocol.NewError(protocol.SourceUnreachable, "")
	}
	return &e
}

// List emits the directory's regular files as rows, then done; or one error frame.
func (f *Files) List(ctx context.Context, payload json.RawMessage, emit Emit) error {
	var req protocol.FilesList
	if err := json.NewDecoder(bytes.NewReader(payload)).Decode(&req); err != nil {
		return emit(protocol.NewError(protocol.Integrity, ""))
	}
	dir, refused := f.resolve(req.Root, req.Directory)
	if refused != nil {
		return emit(*refused)
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return emit(*refusalOf(err))
	}
	rows := make([]map[string]any, 0, len(entries))
	for _, entry := range entries {
		if ctx.Err() != nil {
			return emit(protocol.NewError(protocol.Timeout, ""))
		}
		// A link is followed only to a regular file still within an allowed root.
		path, refusedEntry := f.resolve(req.Root, req.Directory, entry.Name())
		if refusedEntry != nil {
			continue
		}
		info, err := os.Stat(path)
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		if len(rows) >= MaxFileEntries {
			return emit(protocol.NewError(protocol.Bounds, ""))
		}
		rows = append(rows, map[string]any{"name": entry.Name(), "size": info.Size(), "modifiedAt": info.ModTime().UTC().Format(time.RFC3339Nano)})
	}
	if len(rows) > 0 {
		if err := emit(protocol.NewRows(rows)); err != nil {
			return err
		}
	}
	return emit(protocol.NewDone(len(rows), false))
}

// Read emits the file's bytes as rows of chunks, each with its offset, then done; or one error frame.
func (f *Files) Read(ctx context.Context, payload json.RawMessage, emit Emit) error {
	var req protocol.FilesRead
	if err := json.NewDecoder(bytes.NewReader(payload)).Decode(&req); err != nil || req.MaxBytes <= 0 || !segments(req.Name) || strings.Contains(req.Name, "/") {
		return emit(protocol.NewError(protocol.Integrity, ""))
	}
	path, refused := f.resolve(req.Root, req.Directory, req.Name)
	if refused != nil {
		return emit(*refused)
	}
	file, err := os.Open(path)
	if err != nil {
		return emit(*refusalOf(err))
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		e := protocol.NewError(protocol.SourceRefused, "")
		e.Reason = protocol.RefusedNotFound
		return emit(e)
	}
	if info.Size() > req.MaxBytes {
		return emit(protocol.NewError(protocol.Bounds, ""))
	}
	// Read to the bound and one byte past it: a file that grew since it was listed is refused, never cut.
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
			row := map[string]any{"offset": offset, "data": base64.StdEncoding.EncodeToString(buf[:n])}
			if err := emit(protocol.NewRows([]map[string]any{row})); err != nil {
				return err
			}
			offset += int64(n)
			chunks++
		}
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			break
		}
		if err != nil {
			return emit(*refusalOf(err))
		}
	}
	return emit(protocol.NewDone(chunks, false))
}
