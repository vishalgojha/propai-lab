package main

import (
	"context"
	"go.mau.fi/whatsmeow/store/sqlstore"
	waLog "go.mau.fi/whatsmeow/util/log"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func resetFixture(sm *SessionManager) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", "/reset", nil)
	r.Header.Set("X-Broker-ID", "fixture-reset")
	w := httptest.NewRecorder()
	sm.resetHandler(w, r)
	return w
}

func TestResetCancelsAndJoinsStartupBeforeClearingData(t *testing.T) {
	state := &setupDBState{emptyMapping: true, entered: make(chan struct{}), proceed: make(chan struct{})}
	sm := NewSessionManager(nil, setupDB(t, state), setupDB(t, state))
	started := make(chan *BrokerSession, 1)
	go func() { started <- sm.StartOrGet("fixture-reset") }()
	<-state.entered
	resetDone := make(chan *httptest.ResponseRecorder, 1)
	go func() { resetDone <- resetFixture(sm) }()
	deadline := time.Now().Add(time.Second)
	for {
		sm.mu.RLock()
		resetting := sm.resetting["fixture-reset"]
		sm.mu.RUnlock()
		if resetting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("reset barrier never established")
		}
		time.Sleep(time.Millisecond)
	}
	if got := sm.StartOrGetForCodePairing("fixture-reset", "919000000000"); got != nil {
		t.Fatal("new pairing crossed reset barrier")
	}
	close(state.proceed)
	if got := <-started; got != nil {
		t.Fatal("cancelled startup published session after reset began")
	}
	w := <-resetDone
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"credentials_deleted":true`) {
		t.Fatalf("reset result: %d %s", w.Code, w.Body.String())
	}
	if sm.Get("fixture-reset") != nil || sm.lockDB.Stats().InUse != 0 {
		t.Fatal("reset left active session/checked-out lock")
	}
}

func TestResetCannotDeleteWithoutVerifiedSessionOwnership(t *testing.T) {
	state := &setupDBState{emptyMapping: true, acquireDeny: true}
	sm := NewSessionManager(nil, setupDB(t, state), setupDB(t, state))
	w := resetFixture(sm)
	if w.Code != 423 || state.lookups.Load() != 0 || state.execs.Load() != 0 || strings.Contains(w.Body.String(), "reset_at") {
		t.Fatalf("reset touched data or claimed completion without ownership: %d %s", w.Code, w.Body.String())
	}
}

func TestResetCannotConfirmIfUnlockIsFalse(t *testing.T) {
	state := &setupDBState{emptyMapping: true, unlockFalse: true}
	sm := NewSessionManager(nil, setupDB(t, state), setupDB(t, state))
	w := resetFixture(sm)
	if w.Code != 503 || strings.Contains(w.Body.String(), "reset_at") || strings.Contains(w.Body.String(), `"ok":true`) {
		t.Fatalf("reset falsely confirmed ownership release: %d %s", w.Code, w.Body.String())
	}
	if state.closed.Load() == 0 {
		t.Fatal("uncertain lock connection was not discarded")
	}
}

func TestResetTimeoutDoesNotAllowCancelledStartupPublication(t *testing.T) {
	sm := NewSessionManager(nil, nil, nil)
	sm.starting = map[string]chan struct{}{"fixture-reset": make(chan struct{})}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	finish, e := sm.beginReset(ctx, "fixture-reset")
	if e == nil || finish != nil {
		t.Fatal("reset confirmed while setup did not join")
	}
}

func TestResetSessionRejectsStalePairingCallback(t *testing.T) {
	s := &BrokerSession{resetting: true, pairingModeChanged: make(chan struct{}, 1)}
	if s.requestPairing("code", "919000000000") || !s.resetting || s.pairingRequestGeneration != 0 {
		t.Fatal("stale code start revived resetting session")
	}
}

func TestResetReceiptCannotPrecedePendingStartupRetirement(t *testing.T) {
	state := &setupDBState{emptyMapping: true, blockFirstLookupOnly: true, entered: make(chan struct{}), proceed: make(chan struct{})}
	db := setupDB(t, state)
	sm := NewSessionManager(sqlstore.NewWithDB(db, "postgres", waLog.Noop), db, setupDB(t, state))
	started := make(chan *BrokerSession, 1)
	go func() { started <- sm.startOrGet("fixture-reset", func(s *BrokerSession) { s.cancel() }) }()
	<-state.entered
	// Real reset handler, not a synthetic lifecycle helper. The first lookup
	// stays blocked; only reset's own subsequent query may complete normally.
	w := resetFixture(sm)
	close(state.proceed)
	got := <-started
	sm.sessionWg.Wait()
	if w.Code != 200 {
		t.Fatalf("reset returned %d: %s", w.Code, w.Body.String())
	}
	if got != nil || sm.Get("fixture-reset") != nil {
		t.Fatal("reset confirmed while pending setup could still publish the old generation")
	}
}
