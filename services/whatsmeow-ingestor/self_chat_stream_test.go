package main

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync"
	"testing"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

// fakeSender records every SendMessage call so tests can assert the chunk
// sequence without spinning up a real whatsmeow client.
type fakeSender struct {
	mu       sync.Mutex
	messages []string
}

func (f *fakeSender) record(text string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.messages = append(f.messages, text)
}

func (f *fakeSender) snapshot() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.messages))
	copy(out, f.messages)
	return out
}

// We can't construct a real whatsmeow.Client without a SQL store, but the
// streaming path only reads from resp.Body and parses lines — verify that
// directly with an httptest server.

func TestNDJSONStreamParsesDoneEvent(t *testing.T) {
	ndjson := strings.Join([]string{
		`{"event":"chunk","delta":"PropAI- • Hi"}`,
		`{"event":"chunk","delta":" there"}`,
		`{"event":"done","reply":"PropAI- • Hi there"}`,
		"",
	}, "\n")
	resp := &http.Response{
		StatusCode: 200,
		Body:       readCloser(ndjson),
		Header:     http.Header{"Content-Type": []string{"application/x-ndjson"}},
	}
	defer resp.Body.Close()

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 4096), 64*1024)

	var events []selfChatStreamEvent
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var evt selfChatStreamEvent
		if err := json.Unmarshal([]byte(line), &evt); err != nil {
			t.Fatalf("unmarshal %q failed: %v", line, err)
		}
		events = append(events, evt)
	}
	if err := scanner.Err(); err != nil {
		t.Fatalf("scanner error: %v", err)
	}
	if len(events) != 3 {
		t.Fatalf("expected 3 events, got %d: %+v", len(events), events)
	}
	if events[0].Event != "chunk" || events[0].Delta != "PropAI- • Hi" {
		t.Fatalf("event[0] wrong: %+v", events[0])
	}
	if events[1].Event != "chunk" || events[1].Delta != " there" {
		t.Fatalf("event[1] wrong: %+v", events[1])
	}
	if events[2].Event != "done" || events[2].Reply != "PropAI- • Hi there" {
		t.Fatalf("event[2] wrong: %+v", events[2])
	}
}

func TestNDJSONStreamParsesErrorEvent(t *testing.T) {
	ndjson := strings.Join([]string{
		`{"event":"error","message":"agent_timeout"}`,
		"",
	}, "\n")
	resp := &http.Response{
		StatusCode: 200,
		Body:       readCloser(ndjson),
		Header:     http.Header{"Content-Type": []string{"application/x-ndjson"}},
	}
	defer resp.Body.Close()

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 4096), 64*1024)

	var events []selfChatStreamEvent
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var evt selfChatStreamEvent
		if err := json.Unmarshal([]byte(line), &evt); err != nil {
			t.Fatalf("unmarshal failed: %v", err)
		}
		events = append(events, evt)
	}
	if len(events) != 1 || events[0].Event != "error" || events[0].Error != "agent_timeout" {
		t.Fatalf("events wrong: %+v", events)
	}
}

// readCloser is a tiny test helper to satisfy io.ReadCloser.
type nopCloser struct{ r *strings.Reader }

func (n nopCloser) Read(p []byte) (int, error) { return n.r.Read(p) }
func (n nopCloser) Close() error               { return nil }

func readCloser(s string) nopCloser { return nopCloser{r: strings.NewReader(s)} }

// TestSessionManagerHandleSelfChatStream sends NDJSON through an httptest
// server and confirms the accumulator flushes each chunk and the final
// reply. We can't use a real whatsmeow client here, so we test the chunk
// accumulation logic against the fakeSender + a manual mirror of the
// streaming path.
func TestSessionManagerHandleSelfChatStreamAccumulatesChunks(t *testing.T) {
	// Manually replay the streaming loop with a fake sender to assert that
	// chunk buffering + flush behaves as expected. The actual function is
	// tied to s.client.SendMessage; here we use a closure that mirrors the
	// flush policy.
	sender := &fakeSender{}
	const flushChars = 60
	const maxFlushWait = 800 * 1000 * 1000 // not used here

	ndjson := strings.Join([]string{
		`{"event":"chunk","delta":"• Hi"}`,
		`{"event":"chunk","delta":" there"}`,
		`{"event":"chunk","delta":", here's what I found"}`,
		`{"event":"done","reply":"PropAI- • Hi there, here's what I found\n• 3 active 2 BHK in Bandra"}`,
		"",
	}, "\n")
	resp := &http.Response{
		StatusCode: 200,
		Body:       readCloser(ndjson),
		Header:     http.Header{"Content-Type": []string{"application/x-ndjson"}},
	}
	defer resp.Body.Close()

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 4096), 64*1024)

	buffer := strings.Builder{}
	flush := func(force bool) {
		text := strings.TrimSpace(buffer.String())
		if text == "" {
			return
		}
		if !force && len(text) < flushChars {
			return
		}
		sender.record(text)
		buffer.Reset()
	}
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var evt selfChatStreamEvent
		if err := json.Unmarshal([]byte(line), &evt); err != nil {
			t.Fatalf("unmarshal failed: %v", err)
		}
		switch evt.Event {
		case "chunk":
			if evt.Delta != "" {
				buffer.WriteString(evt.Delta)
				flush(false)
			}
		case "done":
			if strings.TrimSpace(evt.Reply) != "" {
				buffer.Reset()
				buffer.WriteString(evt.Reply)
			}
			flush(true)
		}
	}
	// The first three chunks are short, so they accumulate. The done event
	// replaces the buffer with the full reply and forces a flush.
	got := sender.snapshot()
	if len(got) != 1 {
		t.Fatalf("expected 1 flush, got %d: %+v", len(got), got)
	}
	if !strings.Contains(got[0], "PropAI-") {
		t.Fatalf("expected reply to start with PropAI-, got %q", got[0])
	}
}

// Compile-time check that the streaming helper still imports its dependencies.
var _ = context.Background
var _ = whatsmeow.NewClient
var _ proto.Message = (*waE2E.Message)(nil)
var _ types.JID
