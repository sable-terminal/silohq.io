package protocol

import (
	"bytes"
	"io"
	"strings"
	"testing"
)

func TestFramesRoundTripOneObjectPerLine(t *testing.T) {
	var buf bytes.Buffer
	w := NewWriter(&buf)
	if err := w.Write(NewHeartbeat("1.0.0", 3, nil, nil, true)); err != nil {
		t.Fatal(err)
	}
	if err := w.Write(NewDone(2, false)); err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(buf.String(), "\n"); got != 2 {
		t.Fatalf("want one frame per line, got %d lines", got)
	}
	r := NewReader(strings.NewReader(`{"type":"work","id":"0190f4b2-0000-7000-8000-000000000001","kind":"ping","deadline":"2026-11-16T10:00:00Z","payload":{}}` + "\n\n" + `{"type":"close","reason":"revoked"}` + "\n"))
	var first, second Down
	if err := r.Next(&first); err != nil || first.Type != "work" || first.Kind != "ping" {
		t.Fatalf("first frame: %+v %v", first, err)
	}
	if err := r.Next(&second); err != nil || second.Reason != "revoked" {
		t.Fatalf("second frame: %+v %v", second, err)
	}
	var none Down
	if err := r.Next(&none); err != io.EOF {
		t.Fatalf("want EOF, got %v", err)
	}
}

func TestReaderRefusesAFrameOverTheBound(t *testing.T) {
	r := NewReader(strings.NewReader(`{"type":"` + strings.Repeat("x", MaxFrameBytes+1) + `"}` + "\n"))
	var frame Down
	if err := r.Next(&frame); err == nil {
		t.Fatal("a frame over the bound was read")
	}
}
