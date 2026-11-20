package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
)

type preservationSpy struct {
	mu            sync.Mutex
	deletes, puts int
}

func (s *preservationSpy) PutDevice(context.Context, *store.Device) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.puts++
	return nil
}
func (s *preservationSpy) DeleteDevice(context.Context, *store.Device) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deletes++
	return nil
}
func fixtureProtectedDevice() (*store.Device, *preservationSpy) {
	spy := &preservationSpy{}
	jid := types.NewJID("123", types.DefaultUserServer)
	d := &store.Device{ID: &jid, Container: spy, Initialized: true}
	protectDevice(d)
	return d, spy
}
func TestNormalAutomaticDeleteDeniedExplicitPermitIsContextLocal(t *testing.T) {
	d, spy := fixtureProtectedDevice()
	// A permit for another operation does not alter this operation's authority.
	allowed := explicitDeviceDeletion(context.Background(), d)
	if !errors.Is(d.Delete(context.Background()), errAutomaticDeviceDeletion) || spy.deletes != 0 || d.ID == nil || d.Deleted {
		t.Fatal("automatic deletion escaped")
	}
	if err := d.Save(context.Background()); err != nil || spy.puts != 1 {
		t.Fatal("normal device save blocked")
	}
	if err := d.Delete(allowed); err != nil || spy.deletes != 1 || !d.Deleted {
		t.Fatal("explicit account deletion failed")
	}
	other, otherSpy := fixtureProtectedDevice()
	if other.Delete(allowed) == nil || otherSpy.deletes != 0 {
		t.Fatal("permit leaked to unrelated identity")
	}
}
func TestNormalConcurrentAutomaticDeleteAndLoggedOutPreserveAndStop(t *testing.T) {
	old := statusClient
	statusClient = &http.Client{Transport: retirementHTTPTransport{}}
	defer func() { statusClient = old }()
	d, spy := fixtureProtectedDevice()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s := &BrokerSession{device: d, ctx: ctx, cancel: cancel, client: whatsmeow.NewClient(d, waLog.Noop)}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); _ = d.Delete(context.Background()) }()
	go func() {
		defer wg.Done()
		(&SessionManager{}).handleEvent(s, &events.LoggedOut{OnConnect: true, Reason: events.ConnectFailureLoggedOut})
	}()
	wg.Wait()
	if ctx.Err() == nil || d.ID == nil || d.Deleted || s.device != d || spy.deletes != 0 {
		t.Fatal("remote rejection erased identity or failed to stop")
	}
	// The existing deliberate clear path can still remove this rejected identity.
	if err := s.clearDevice(); err != nil || spy.deletes != 1 {
		t.Fatal("deliberate clear no longer works", err)
	}
}
func TestNormalAccountActionsStillRequireExistingInternalAuthentication(t *testing.T) {
	t.Setenv("PROPAI_INTERNAL_TOKEN", "local-test-token")
	for _, path := range []string{"/connect", "/reset", "/pair-code/start", "/send-message", "/sync-groups"} {
		called := false
		handler := internalOnly(func(w http.ResponseWriter, r *http.Request) { called = true; w.WriteHeader(204) }, false)
		req := httptest.NewRequest("POST", path+"?explicit_device_deletion=true", nil)
		denied := httptest.NewRecorder()
		handler(denied, req)
		if denied.Code != 401 || called {
			t.Fatal(path, "unauthenticated action admitted")
		}
		req.Header.Set("X-PropAI-Internal-Token", "local-test-token")
		admitted := httptest.NewRecorder()
		handler(admitted, req)
		if admitted.Code != 204 || !called {
			t.Fatal(path, "existing authenticated action blocked")
		}
		if req.Context().Value(explicitDeviceDeletionKey{}) != nil {
			t.Fatal("HTTP parameter minted deletion permit")
		}
	}
}
func TestStartupSelectionExactAndDoesNotBlockNewAccountFunctions(t *testing.T) {
	for _, raw := range []string{"a,", "a,,b", "a b", "a,a"} {
		if _, err := startupBrokerSelection(raw); err == nil {
			t.Fatal(raw)
		}
	}
	selected, err := startupBrokerSelection("existing-a,existing-b")
	if err != nil {
		t.Fatal(err)
	}
	if !selectStartupBroker("existing-a", selected) || selectStartupBroker("existing-c", selected) {
		t.Fatal("wrong startup identity")
	}
	if !selectStartupBroker("existing-c", nil) {
		t.Fatal("full rollout disabled")
	}
}

func TestActualResetHandlerCanDeliberatelyClearGuardedRejectedDevice(t *testing.T) {
	t.Setenv("PROPAI_INTERNAL_TOKEN", "local-test-token")
	old := statusClient
	statusClient = &http.Client{Transport: retirementHTTPTransport{}}
	defer func() { statusClient = old }()
	state := &setupDBState{emptyMapping: true}
	db := setupDB(t, state)
	sm := NewSessionManager(sqlstore.NewWithDB(db, "postgres", waLog.Noop), db, setupDB(t, state))
	d, spy := fixtureProtectedDevice()
	s := sm.newSession("fixture-reset", d)
	s.client = whatsmeow.NewClient(d, waLog.Noop)
	lock, locked, err := sm.acquireBrokerLock(context.Background(), s.brokerID)
	if err != nil || !locked {
		t.Fatal(err)
	}
	s.lockConn = lock
	sm.sessions[s.brokerID] = s
	close(s.loopDone)
	handler := internalOnly(sm.resetHandler, false)
	req := httptest.NewRequest("POST", "/reset?explicit_device_deletion=true", nil)
	req.Header.Set("X-Broker-ID", s.brokerID)
	denied := httptest.NewRecorder()
	handler(denied, req)
	if denied.Code != 401 || spy.deletes != 0 {
		t.Fatal("unauthorized reset touched device")
	}
	if d.Delete(context.Background()) == nil {
		t.Fatal("automatic device deletion escaped")
	}
	req.Header.Set("X-PropAI-Internal-Token", "local-test-token")
	response := httptest.NewRecorder()
	handler(response, req)
	if response.Code != 200 || spy.deletes != 1 || !d.Deleted {
		t.Fatalf("explicit reset failed: %d %s deleted%d", response.Code, response.Body.String(), spy.deletes)
	}
	if sm.Get(s.brokerID) != nil {
		t.Fatal("reset retained cancelled session")
	}
}

func TestActualRunSessionConstructsProtectedRealClientBeforeAnyNetwork(t *testing.T) {
	oldStatus := statusClient
	statusClient = &http.Client{Transport: retirementHTTPTransport{}}
	defer func() { statusClient = oldStatus }()
	originalFactory := newSessionClient
	defer func() { newSessionClient = originalFactory }()
	spy := &preservationSpy{}
	jid := types.NewJID("123", types.DefaultUserServer)
	device := &store.Device{ID: &jid, Container: spy, Initialized: true}
	sm := NewSessionManager(nil, nil, nil)
	session := sm.newSession("local-startup-wiring", device)
	var actual *whatsmeow.Client
	newSessionClient = func(d *store.Device, logger waLog.Logger) *whatsmeow.Client {
		actual = originalFactory(d, logger)
		// Deliberately stop exactly at the real constructor boundary. This executes
		// runSession/runSessionLoop through construction without any WhatsApp socket.
		session.cancel()
		panic("local test stops before network")
	}
	sm.sessionWg.Add(1)
	sm.runSession(session)
	if actual == nil || actual.Store != device {
		t.Fatal("actual startup loop did not construct real client")
	}
	if _, ok := actual.Store.Container.(preservingDeviceContainer); !ok {
		t.Fatal("actual client constructed without automatic deletion protection")
	}
	if err := actual.Store.Delete(context.Background()); !errors.Is(err, errAutomaticDeviceDeletion) || spy.deletes != 0 || device.ID == nil {
		t.Fatal("actual startup client can delete stored identity")
	}
}
