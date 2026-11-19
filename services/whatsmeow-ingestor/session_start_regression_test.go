package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"fmt"
	"io"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type setupDriver struct{ state *setupDBState }
type setupDBState struct {
	mappingWriteEntered  chan struct{}
	mappingWriteProceed  chan struct{}
	mappingInserts       atomic.Int32
	mappingPresent       atomic.Bool
	unlocks              atomic.Int32
	lookups              atomic.Int32
	locks                atomic.Int32
	closed               atomic.Int32
	unlockFalse          bool
	unlockFail           bool
	blockFirstLookupOnly bool
	emptyMapping         bool
	lookupFail           bool
	acquireDeny          bool
	execs                atomic.Int32
	acquireFail          bool
	entered              chan struct{}
	proceed              chan struct{}
	once                 sync.Once
}
type setupConn struct{ state *setupDBState }
type setupRows struct {
	value driver.Value
	read  bool
}

func (d setupDriver) Open(string) (driver.Conn, error)   { return &setupConn{d.state}, nil }
func (c *setupConn) Prepare(string) (driver.Stmt, error) { return nil, errors.New("unused") }
func (c *setupConn) Close() error                        { c.state.closed.Add(1); return nil }
func (c *setupConn) Begin() (driver.Tx, error)           { return nil, errors.New("unused") }
func (r *setupRows) Columns() []string                   { return []string{"value"} }
func (r *setupRows) Close() error                        { return nil }
func (r *setupRows) Next(dst []driver.Value) error {
	if r.read {
		return io.EOF
	}
	r.read = true
	dst[0] = r.value
	return nil
}
func (c *setupConn) QueryContext(ctx context.Context, q string, _ []driver.NamedValue) (driver.Rows, error) {
	if strings.Contains(q, "pg_advisory_unlock") {
		c.state.unlocks.Add(1)
		if c.state.unlockFail {
			return nil, errors.New("fixture unlock failed")
		}
		return &setupRows{value: !c.state.unlockFalse}, nil
	}
	if strings.Contains(q, "pg_try_advisory_lock") {
		c.state.locks.Add(1)
		if c.state.acquireFail {
			return nil, errors.New("fixture lock response lost")
		}
		return &setupRows{value: !c.state.acquireDeny}, nil
	}
	lookupNumber := c.state.lookups.Add(1)
	if c.state.entered != nil && (!c.state.blockFirstLookupOnly || lookupNumber == 1) {
		c.state.once.Do(func() { close(c.state.entered) })
		select {
		case <-c.state.proceed:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	if c.state.lookupFail {
		return nil, errors.New("fixture database unavailable")
	}
	if c.state.emptyMapping {
		return &setupRows{read: true}, nil
	}
	return &setupRows{value: "fixture-device"}, nil
}
func (c *setupConn) ExecContext(ctx context.Context, q string, _ []driver.NamedValue) (driver.Result, error) {
	if strings.Contains(q, "INSERT INTO broker_whatsapp_devices") {
		c.state.mappingInserts.Add(1)
		if c.state.mappingWriteEntered != nil {
			close(c.state.mappingWriteEntered)
			select {
			case <-c.state.mappingWriteProceed:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		c.state.mappingPresent.Store(true)
	}
	if strings.Contains(q, "DELETE FROM broker_whatsapp_devices") {
		c.state.mappingPresent.Store(false)
	}
	c.state.execs.Add(1)
	if c.state.unlockFail {
		return nil, errors.New("fixture unlock failed")
	}
	return driver.RowsAffected(1), nil
}

var setupDriverID atomic.Int32

func setupDB(t *testing.T, state *setupDBState) *sql.DB {
	t.Helper()
	name := fmt.Sprintf("setup-fixture-%d", setupDriverID.Add(1))
	sql.Register(name, setupDriver{state})
	db, err := sql.Open(name, "")
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(5)
	t.Cleanup(func() { db.Close() })
	return db
}

func TestSessionLocksDoNotStarveMappingPool(t *testing.T) {
	state := &setupDBState{}
	mapping := setupDB(t, state)
	locks := setupDB(t, state)
	sm := NewSessionManager(nil, mapping, locks)
	var held []*brokerLockHandle
	for n := 0; n < 5; n++ {
		conn, ok, err := sm.acquireBrokerLock(context.Background(), fmt.Sprint(n))
		if err != nil || !ok {
			t.Fatalf("lock %d: %v", n, err)
		}
		held = append(held, conn)
	}
	defer func() {
		for n, c := range held {
			releaseBrokerLockConn(c, fmt.Sprint(n))
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if got, err := sm.lookupDeviceJID(ctx, "new"); err != nil || got != "fixture-device" {
		t.Fatalf("mapping starved by held locks: %q %v", got, err)
	}
}

func TestFailedUnlockDiscardsPhysicalConnection(t *testing.T) {
	state := &setupDBState{unlockFail: true}
	db := setupDB(t, state)
	db.SetMaxIdleConns(2)
	conn, err := db.Conn(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	releaseBrokerLockConn(&brokerLockHandle{conn: conn}, "fixture")
	if state.closed.Load() != 1 {
		t.Fatalf("possibly locked physical connection returned to pool, closes=%d", state.closed.Load())
	}
}

func TestConcurrentStartupHasCanonicalFailureStatus(t *testing.T) {
	state := &setupDBState{lookupFail: true, entered: make(chan struct{}), proceed: make(chan struct{})}
	sm := NewSessionManager(nil, setupDB(t, state), setupDB(t, state))
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); sm.StartOrGet("broker-a") }()
	<-state.entered
	request := httptest.NewRequest("GET", "/pair-code/status?broker_id=broker-a", nil)
	// Match the actual broker-id input header used by normal handlers.
	request.Header.Set("X-Broker-ID", "broker-a")
	response := httptest.NewRecorder()
	sm.pairCodeStatusHandler(response, request)
	if !strings.Contains(response.Body.String(), "generating") {
		t.Fatalf("in-flight status not canonical: %s", response.Body.String())
	}
	wg.Add(1)
	go func() { defer wg.Done(); sm.StartOrGet("broker-a") }()
	// Keep the first startup blocked while the second joins it.
	time.Sleep(20 * time.Millisecond)
	close(state.proceed)
	wg.Wait()
	if state.locks.Load() != 1 || state.lookups.Load() != 1 {
		t.Fatalf("duplicate startup: locks=%d lookups=%d", state.locks.Load(), state.lookups.Load())
	}
	response = httptest.NewRecorder()
	sm.pairCodeStatusHandler(response, request)
	if !strings.Contains(response.Body.String(), "pairing_error") || !strings.Contains(response.Body.String(), "database lookup failed") {
		t.Fatalf("lost startup error: %s", response.Body.String())
	}
	other := httptest.NewRequest("GET", "/pair-code/status?broker_id=broker-b", nil)
	other.Header.Set("X-Broker-ID", "broker-b")
	response = httptest.NewRecorder()
	sm.pairCodeStatusHandler(response, other)
	if !strings.Contains(response.Body.String(), "not_started") || strings.Contains(response.Body.String(), "database lookup failed") {
		t.Fatalf("cross-broker error leak: %s", response.Body.String())
	}
}

func TestAcquireErrorDiscardsPhysicalConnection(t *testing.T) {
	state := &setupDBState{acquireFail: true}
	locks := setupDB(t, state)
	locks.SetMaxIdleConns(2)
	sm := NewSessionManager(nil, setupDB(t, &setupDBState{}), locks)
	c, ok, err := sm.acquireBrokerLock(context.Background(), "fixture")
	if c != nil || ok || err == nil || state.closed.Load() != 1 {
		t.Fatalf("ambiguous lock not discarded: conn=%v ok=%v err=%v closes=%d", c, ok, err, state.closed.Load())
	}
}

func TestSixthLockIsBoundedAndDoesNotBlockMapping(t *testing.T) {
	state := &setupDBState{}
	locks := setupDB(t, state)
	mapping := setupDB(t, state)
	sm := NewSessionManager(nil, mapping, locks)
	held := []*brokerLockHandle{}
	for i := 0; i < 5; i++ {
		c, ok, e := sm.acquireBrokerLock(context.Background(), fmt.Sprint(i))
		if e != nil || !ok {
			t.Fatal(e)
		}
		held = append(held, c)
	}
	defer func() {
		for i, c := range held {
			releaseBrokerLockConn(c, fmt.Sprint(i))
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	_, ok, e := sm.acquireBrokerLock(ctx, "sixth")
	if ok || !errors.Is(e, context.DeadlineExceeded) {
		t.Fatalf("capacity should fail bounded: %v %v", ok, e)
	}
	if _, e := sm.lookupDeviceJID(context.Background(), "mapping"); e != nil {
		t.Fatal(e)
	}
	if locks.Stats().OpenConnections != 5 {
		t.Fatalf("lock limit silently raised: %+v", locks.Stats())
	}
}

func TestCodeStartHandlerPreservesDatabaseErrorAs503(t *testing.T) {
	sm := NewSessionManager(nil, setupDB(t, &setupDBState{lookupFail: true}), setupDB(t, &setupDBState{}))
	r := httptest.NewRequest("POST", "/pair-code/start", strings.NewReader(`{"phone":"919000000000"}`))
	r.Header.Set("X-Broker-ID", "fixture")
	w := httptest.NewRecorder()
	sm.pairCodeStartHandler(w, r)
	if w.Code != 503 || !strings.Contains(w.Body.String(), "session_start_failed") || !strings.Contains(w.Body.String(), "database lookup failed") {
		t.Fatalf("wrong response: %d %s", w.Code, w.Body.String())
	}
	// Another explicit attempt must execute setup again, not remain permanently stuck on a failed single-flight.
	w = httptest.NewRecorder()
	r = httptest.NewRequest("POST", "/pair-code/start", strings.NewReader(`{"phone":"919000000000"}`))
	r.Header.Set("X-Broker-ID", "fixture")
	sm.pairCodeStartHandler(w, r)
	if w.Code != 503 || sm.db.Stats().InUse != 0 || sm.lockDB.Stats().InUse != 0 {
		t.Fatalf("failure leaked state/connections: %d", w.Code)
	}
}

func TestDuplicatePairingJoinsOperationWithoutResettingCode(t *testing.T) {
	s := &BrokerSession{pairingModeChanged: make(chan struct{}, 1)}
	if !s.requestPairing("code", "919000000000") {
		t.Fatal("first request missing")
	}
	id := s.status.PairingOperationID
	generation := s.pairingRequestGeneration
	s.status.PairingCode = "FIXTURE"
	s.status.ConnectionState = "pairing_code"
	if s.requestPairing("code", "919000000000") {
		t.Fatal("duplicate restarted active code")
	}
	if id == "" || s.status.PairingOperationID != id || s.pairingRequestGeneration != generation || s.status.PairingCode != "FIXTURE" {
		t.Fatal("operation/code changed")
	}
	s.status.PairingError = "failed"
	if !s.requestPairing("code", "919000000000") || s.status.PairingOperationID == id {
		t.Fatal("fresh explicit request after failure did not advance operation")
	}
}

func TestFalseUnlockDiscardsPhysicalConnection(t *testing.T) {
	state := &setupDBState{unlockFalse: true}
	db := setupDB(t, state)
	db.SetMaxIdleConns(2)
	c, e := db.Conn(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	releaseBrokerLockConn(&brokerLockHandle{conn: c}, "fixture")
	if state.closed.Load() != 1 {
		t.Fatal("false unlock returned uncertain connection to pool")
	}
}
