package main

import (
	"context"
	"database/sql"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
)

func TestRealPostgresSingletonCapacityIsolationAndHandover(t *testing.T) {
	dsn := os.Getenv("PROPAI_TEST_LOCAL_PG_DSN")
	if dsn == "" {
		t.Skip("disposable PG not running")
	}
	if !strings.Contains(dsn, "/tmp/propai-pairing-pg") && !strings.Contains(dsn, "%2Ftmp%2Fpropai-pairing-pg") {
		t.Fatal("not disposable socket")
	}
	open := func() *sql.DB {
		d, e := sql.Open("pgx", dsn)
		if e != nil {
			t.Fatal(e)
		}
		d.SetMaxOpenConns(1)
		d.SetMaxIdleConns(0)
		t.Cleanup(func() { d.Close() })
		return d
	}
	locks, otherDB, mapping := open(), open(), open()
	var losses atomic.Int32
	owner, e := newSingletonLockOwner(context.Background(), locks, func() { losses.Add(1) })
	if e != nil {
		t.Fatal(e)
	}
	defer owner.close()
	if !owner.check(context.Background()) {
		t.Fatal("fresh owner is not verifiable")
	}
	if other, e := newSingletonLockOwner(context.Background(), otherDB, func() {}); e == nil {
		other.close()
		t.Fatal("concurrent singleton admitted")
	}
	sm := NewSessionManager(nil, mapping, locks)
	sm.owner = owner
	handles := map[string]*brokerLockHandle{}
	for _, id := range []string{"a", "b", "c", "d", "e", "f", "g", "h"} {
		c, ok, e := sm.acquireBrokerLock(context.Background(), id)
		if e != nil || !ok {
			t.Fatalf("broker %s beyond5 failed: %v", id, e)
		}
		handles[id] = c
	}
	if locks.Stats().InUse != 1 {
		t.Fatalf("brokers consumed %d owner connections", locks.Stats().InUse)
	}
	for _, id := range []string{"a", "b"} {
		var ok bool
		if e := otherDB.QueryRow("SELECT pg_try_advisory_lock($1)", brokerLockKey(id)).Scan(&ok); e != nil || ok {
			t.Fatalf("legacy competitor crossed broker %s: %v", id, e)
		}
	}
	if _, ok, e := sm.acquireBrokerLock(context.Background(), "a"); e != nil || ok {
		t.Fatal("same-owner duplicate caused reentrant acquisition")
	}
	if !releaseBrokerLockConn(handles["a"], "a") {
		t.Fatal("target release failed")
	}
	if !owner.check(context.Background()) {
		t.Fatal("broker release lost service ownership")
	}
	// Same legacy broker can be reacquired after its release while b stays held.
	conn, e := otherDB.Conn(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	var ok bool
	if e = conn.QueryRowContext(context.Background(), "SELECT pg_try_advisory_lock($1)", brokerLockKey("a")).Scan(&ok); e != nil || !ok {
		t.Fatal("target lock not released")
	}
	if e = conn.QueryRowContext(context.Background(), "SELECT pg_try_advisory_lock($1)", brokerLockKey("b")).Scan(&ok); e != nil || ok {
		t.Fatal("release of a affected b")
	}
	if !releaseBrokerLockConn(&brokerLockHandle{conn: conn}, "a") {
		t.Fatal("competitor release failed")
	}
	if _, e = mapping.Exec("CREATE TABLE IF NOT EXISTS broker_whatsapp_devices (whatsapp_connection_key text primary key,device_jid text not null)"); e != nil {
		t.Fatal(e)
	}
	if _, e = mapping.Exec("CREATE TABLE IF NOT EXISTS broker_whatsapp_device_history (id serial primary key,whatsapp_connection_key text,device_jid text,wiped_at timestamptz default now(),reason text)"); e != nil {
		t.Fatal(e)
	}
	r := httptest.NewRequest("POST", "/reset", nil)
	r.Header.Set("X-Broker-ID", "fixture-reset")
	w := httptest.NewRecorder()
	sm.resetHandler(w, r)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"credentials_deleted":true`) {
		t.Fatalf("real reset singleton branch: %d %s", w.Code, w.Body.String())
	}
	if !owner.check(context.Background()) {
		t.Fatal("reset released global owner")
	}
	// Terminate only our disposable test backend. No real provider access.
	var pid int
	owner.mu.Lock()
	e = owner.conn.QueryRowContext(context.Background(), "SELECT pg_backend_pid()").Scan(&pid)
	owner.mu.Unlock()
	if e != nil {
		t.Fatal(e)
	}
	if _, e = mapping.Exec("SELECT pg_terminate_backend($1)", pid); e != nil {
		t.Fatal(e)
	}
	if owner.check(context.Background()) || losses.Load() != 1 {
		t.Fatal("backend loss not terminal")
	}
	if _, ok, e := sm.acquireBrokerLock(context.Background(), "after-loss"); e == nil || ok {
		t.Fatal("owner silently reconnected")
	}
	if releaseBrokerLockConn(handles["b"], "b") {
		t.Fatal("uncertain ownership release confirmed")
	}
	if losses.Load() != 1 {
		t.Fatal("loss action repeated")
	}
	next, e := newSingletonLockOwner(context.Background(), otherDB, func() {})
	if e != nil {
		t.Fatalf("new owner after old backend loss: %v", e)
	}
	defer next.close()
	c, ok, e := next.acquire(context.Background(), "b")
	if e != nil || !ok {
		t.Fatal("legacy broker lock stranded after terminal backend loss")
	}
	if !releaseBrokerLockConn(c, "b") {
		t.Fatal("new owner could not release")
	}
	// Successful connectivity alone must not preserve ownership if service key vanished.
	next.mu.Lock()
	e = next.conn.QueryRowContext(context.Background(), "SELECT pg_advisory_unlock($1)", ingestorOwnerKey).Scan(&ok)
	next.mu.Unlock()
	if e != nil || !ok {
		t.Fatal("could not create lost-key-but-live-backend case")
	}
	if next.check(context.Background()) {
		t.Fatal("a live connection without service key passed owner verification")
	}
	// This proves PG ownership cleanup, NOT stopped WhatsApp work or fencing.
}
