package main

import (
	"context"
	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type retirementHTTPTransport struct{}

func (retirementHTTPTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader("")), Header: make(http.Header)}, nil
}

func TestActiveResetDrainsRealPairSuccessAndJoinsLoopBeforeReceipt(t *testing.T) {
	for _, shared := range []bool{false, true} {
		t.Run(map[bool]string{false: "bounded", true: "singleton"}[shared], func(t *testing.T) {
			old := statusClient
			statusClient = &http.Client{Transport: retirementHTTPTransport{}}
			defer func() { statusClient = old }()
			state := &setupDBState{emptyMapping: true, mappingWriteEntered: make(chan struct{}), mappingWriteProceed: make(chan struct{})}
			db := setupDB(t, state)
			locks := setupDB(t, state)
			sm := NewSessionManager(sqlstore.NewWithDB(db, "postgres", waLog.Noop), db, locks)
			if shared {
				conn, e := locks.Conn(context.Background())
				if e != nil {
					t.Fatal(e)
				}
				sm.owner = &singletonLockOwner{conn: conn, held: map[string]bool{}, onLoss: func() { t.Error("unexpected ownership loss") }}
				defer sm.owner.close()
			}
			s := sm.newSession("fixture-reset", sm.container.NewDevice())
			s.client = whatsmeow.NewClient(s.device, waLog.Noop)
			handle, ok, e := sm.acquireBrokerLock(context.Background(), s.brokerID)
			if e != nil || !ok {
				t.Fatal(e)
			}
			s.lockConn = handle
			sm.sessions[s.brokerID] = s
			eventDone := make(chan struct{})
			go func() {
				defer close(eventDone)
				sm.handleEvent(s, &events.PairSuccess{ID: types.JID{User: "919000000000", Server: types.DefaultUserServer}})
			}()
			<-state.mappingWriteEntered
			response := make(chan *httptest.ResponseRecorder, 1)
			go func() { response <- resetFixture(sm) }()
			deadline := time.Now().Add(time.Second)
			for {
				s.mu.RLock()
				barrier := s.resetting
				s.mu.RUnlock()
				if barrier {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("no reset admission barrier")
				}
				time.Sleep(time.Millisecond)
			}
			sm.handleEvent(s, &events.PairSuccess{ID: types.JID{User: "919000000001", Server: types.DefaultUserServer}})
			if state.mappingInserts.Load() != 1 {
				t.Fatal("late callback crossed admission barrier")
			}
			select {
			case w := <-response:
				t.Fatalf("receipt before admitted callback drained: %d %s", w.Code, w.Body.String())
			default:
			}
			if state.unlocks.Load() != 0 {
				t.Fatal("owner released while callback remained")
			}
			close(state.mappingWriteProceed)
			<-eventDone
			// A controlled worker holds loopDone open after cancellation. This isolates
			// the handler's join contract; the next test exercises real cancelled loop.
			select {
			case <-s.ctx.Done():
			case <-time.After(time.Second):
				t.Fatal("reset never requested loop stop")
			}
			select {
			case <-response:
				t.Fatal("receipt before loop retirement")
			default:
			}
			if state.unlocks.Load() != 0 {
				t.Fatal("lock released before loop retirement")
			}
			close(s.loopDone)
			w := <-response
			if w.Code != 200 || !strings.Contains(w.Body.String(), `"credentials_deleted":true`) {
				t.Fatalf("reset failed: %d %s", w.Code, w.Body.String())
			}
			if state.mappingPresent.Load() || state.unlocks.Load() != 1 {
				t.Fatalf("mapping resurrected or lock not released: mapping=%v unlocks=%d", state.mappingPresent.Load(), state.unlocks.Load())
			}
		})
	}
}

func TestRealCancelledLoopRetiresWithoutReleasingResetOwnership(t *testing.T) {
	state := &setupDBState{}
	locks := setupDB(t, state)
	sm := NewSessionManager(nil, nil, locks)
	s := sm.newSession("retiring", nil)
	h, ok, e := sm.acquireBrokerLock(context.Background(), s.brokerID)
	if e != nil || !ok {
		t.Fatal(e)
	}
	s.lockConn = h
	s.resetting = true
	s.cancel()
	sm.sessions[s.brokerID] = s
	sm.sessionWg.Add(1)
	go sm.runSession(s)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if e := s.retireLoop(ctx); e != nil {
		t.Fatal(e)
	}
	sm.sessionWg.Wait()
	if state.unlocks.Load() != 0 {
		t.Fatal("loop released destructive reset owner before handler was done")
	}
	if !sm.Remove(s.brokerID) || state.unlocks.Load() != 1 {
		t.Fatal("reset could not finalize ownership after retirement")
	}
}

func TestPanicRetryRetainsOwnershipUntilLifetimeStops(t *testing.T) {
	old := statusClient
	statusClient = &http.Client{Transport: retirementHTTPTransport{}}
	defer func() { statusClient = old }()
	state := &setupDBState{}
	locks := setupDB(t, state)
	sm := NewSessionManager(nil, nil, locks)
	// nil container/device forces a genuine loop panic before WhatsApp networking.
	s := sm.newSession("panic-retirement", nil)
	h, ok, e := sm.acquireBrokerLock(context.Background(), s.brokerID)
	if e != nil || !ok {
		t.Fatal(e)
	}
	s.lockConn = h
	sm.sessionWg.Add(1)
	go sm.runSession(s)
	deadline := time.Now().Add(3 * time.Second)
	for {
		s.mu.RLock()
		n := s.panicRetries
		s.mu.RUnlock()
		if n >= 2 {
			break
		}
		if time.Now().After(deadline) {
			s.cancel()
			t.Fatal("loop did not retry panic inside lifetime")
		}
		time.Sleep(time.Millisecond)
	}
	if state.unlocks.Load() != 0 {
		s.cancel()
		t.Fatal("panic retry released ownership")
	}
	s.cancel()
	<-s.loopDone
	sm.sessionWg.Wait()
	if state.unlocks.Load() != 1 {
		t.Fatal("final stopped lifetime did not release exactly once")
	}
}

func TestDisconnectCannotAcknowledgeBeforeRetirement(t *testing.T) {
	state := &setupDBState{}
	locks := setupDB(t, state)
	sm := NewSessionManager(nil, nil, locks)
	s := sm.newSession("fixture-reset", nil)
	h, ok, e := sm.acquireBrokerLock(context.Background(), s.brokerID)
	if e != nil || !ok {
		t.Fatal(e)
	}
	s.lockConn = h
	sm.sessions[s.brokerID] = s
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		r := httptest.NewRequest("POST", "/disconnect", nil)
		r.Header.Set("X-Broker-ID", s.brokerID)
		w := httptest.NewRecorder()
		sm.disconnectHandler(w, r)
		result <- w
	}()
	<-s.ctx.Done()
	select {
	case <-result:
		t.Fatal("disconnect acknowledged before loop exit")
	default:
	}
	if state.unlocks.Load() != 0 {
		t.Fatal("disconnect released owner before loop exit")
	}
	if sm.StartOrGet(s.brokerID) != nil {
		t.Fatal("new start crossed disconnect barrier")
	}
	close(s.loopDone)
	w := <-result
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"disconnect_confirmed":true`) || state.unlocks.Load() != 1 {
		t.Fatalf("disconnect not confirmed after retirement: %d %s", w.Code, w.Body.String())
	}
}

func TestDisconnectCancelsPendingStartupBeforeConfirming(t *testing.T) {
	state := &setupDBState{emptyMapping: true, entered: make(chan struct{}), proceed: make(chan struct{})}
	db := setupDB(t, state)
	sm := NewSessionManager(nil, db, setupDB(t, state))
	started := make(chan *BrokerSession, 1)
	go func() { started <- sm.StartOrGet("fixture-reset") }()
	<-state.entered
	r := httptest.NewRequest("POST", "/disconnect", nil)
	r.Header.Set("X-Broker-ID", "fixture-reset")
	w := httptest.NewRecorder()
	sm.disconnectHandler(w, r)
	close(state.proceed)
	s := <-started
	if w.Code != 200 || s != nil || sm.Get("fixture-reset") != nil || state.unlocks.Load() != 1 {
		t.Fatalf("disconnect confirmed pending setup generation: status=%d session=%v unlocks=%d", w.Code, s != nil, state.unlocks.Load())
	}
}
