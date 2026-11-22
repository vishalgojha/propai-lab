package main

import (
	"context"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
)

// Controlled race: a delayed durable "running" write from a Connected event
// must never overwrite an owner's explicit disconnect.
//
// The Connected write is synchronous inside handleEvent, which is admitted and
// tracked via eventWg (session_retirement.go). The disconnect handler's
// barrier+drain therefore cannot complete while the tracked write is blocked;
// only after retirement is confirmed does the handler write "stopped". Final
// durable state must be "stopped", and the reconciler must refuse to heal the
// broker afterwards.
//
// Run repeatedly under -race (CI: go test -race -count=20 -run DesiredStateRace).
func TestDesiredStateRaceDelayedConnectedWriteVsDisconnect(t *testing.T) {
	state := &setupDBState{}
	locks := setupDB(t, state)
	sm := NewSessionManager(nil, nil, locks)

	writeStarted := make(chan string, 1)
	release := make(chan struct{})
	var mu sync.Mutex
	var writes []string
	first := true
	sm.desiredStateWriter = func(brokerID, st string) {
		if first {
			first = false
			writeStarted <- st
			<-release // hold the tracked "running" write mid-flight
		}
		mu.Lock()
		writes = append(writes, st)
		mu.Unlock()
	}

	s := sm.newSession("fixture-race", nil)
	s.client = whatsmeow.NewClient(&store.Device{}, waLog.Noop)
	h, ok, err := sm.acquireBrokerLock(context.Background(), s.brokerID)
	if err != nil || !ok {
		t.Fatalf("acquire broker lock: ok=%v err=%v", ok, err)
	}
	s.lockConn = h
	sm.sessions[s.brokerID] = s

	// A Connected event lands and its durable "running" write blocks
	// mid-flight, still tracked by eventWg.
	go sm.handleEvent(s, &events.Connected{})
	select {
	case got := <-writeStarted:
		if got != desiredStateRunning {
			t.Fatalf("first desired-state write = %q, want running", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Connected event did not reach the desired-state write")
	}

	// While the tracked write is blocked, the owner disconnects. The handler
	// must NOT acknowledge: the reset barrier's drain waits for the tracked
	// write. Do not release the write before asserting the handler waits.
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		r := httptest.NewRequest("POST", "/disconnect", nil)
		r.Header.Set("X-Broker-ID", s.brokerID)
		w := httptest.NewRecorder()
		sm.disconnectHandler(w, r)
		result <- w
	}()
	select {
	case <-result:
		t.Fatal("disconnect acknowledged while the tracked running write was still blocked")
	case <-time.After(200 * time.Millisecond):
	}

	// Let the tracked write land; drain then completes, Remove cancels the
	// session lifetime, and retirement finishes once the loop reports done.
	close(release)
	select {
	case <-s.ctx.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("disconnect did not cancel the session lifetime")
	}
	close(s.loopDone)

	select {
	case w := <-result:
		if w.Code != 200 {
			t.Fatalf("disconnect failed after retirement: %d %s", w.Code, w.Body.String())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("disconnect did not complete after the blocked write was released")
	}

	mu.Lock()
	got := append([]string(nil), writes...)
	mu.Unlock()
	if len(got) != 2 || got[0] != desiredStateRunning || got[1] != desiredStateStopped {
		t.Fatalf("desired-state writes = %v, want [running stopped] (stopped must be last)", got)
	}

	// Final durable state across a restart is "stopped": a fresh manager
	// reading this row must never auto-heal the broker.
	final := got[len(got)-1]
	if action := reconcileAction(false, final, true); action != "skip-no-durable-want" {
		t.Fatalf("after explicit disconnect the reconciler would %q; it must never auto-restart", action)
	}
}

// Connected events arriving after a session entered reset must not be
// admitted at all, so no "running" write can sneak in behind a disconnect.
func TestDesiredStateConnectedNotAdmittedDuringReset(t *testing.T) {
	sm := NewSessionManager(nil, nil, nil)
	called := false
	sm.desiredStateWriter = func(brokerID, state string) { called = true }
	s := sm.newSession("fixture-admit", nil)
	s.mu.Lock()
	s.resetting = true
	s.mu.Unlock()
	sm.handleEvent(s, &events.Connected{})
	if called {
		t.Fatal("desired-state write admitted for a session under reset")
	}
}
