package main

import (
	"context"
	"database/sql"
	"go.mau.fi/whatsmeow/store/sqlstore"
	waLog "go.mau.fi/whatsmeow/util/log"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestSessionLockConfigurationFailsClosed(t *testing.T) {
	cases := []struct {
		dsn, mode string
		ok        bool
	}{
		{"", "", false},
		{"postgres://local/db", "transaction", false},
		{"postgres://u:p@aws-0-ap-northeast-1.pooler.supabase.com:6543/db", "session", false},
		{"postgres://u:p@aws-0-ap-northeast-1.pooler.supabase.com:5432/db", "session", true},
		{"postgres://u:p@db.example.supabase.co:5432/db", "direct", true},
	}
	for _, c := range cases {
		t.Setenv("PROPAI_SESSION_LOCK_DATABASE_URL", c.dsn)
		t.Setenv("PROPAI_SESSION_LOCK_DATABASE_MODE", c.mode)
		_, e := resolveSessionLockDatabaseURL()
		if (e == nil) != c.ok {
			t.Fatalf("configuration result mode=%s want=%v err=%v", c.mode, c.ok, e)
		}
	}
}

// This suite runs only against a disposable local Postgres created for these tests.
// It never connects to a provider or uses production credentials.
func TestRealPostgresSessionLockLifecycle(t *testing.T) {
	dsn := os.Getenv("PROPAI_TEST_LOCAL_PG_DSN")
	if dsn == "" {
		t.Skip("disposable local PG not running")
	}
	if !strings.Contains(dsn, "/tmp/propai-pairing-pg") && !strings.Contains(dsn, "%2Ftmp%2Fpropai-pairing-pg") {
		t.Fatal("local test DSN must point to disposable test socket")
	}
	open := func() *sql.DB {
		d, e := sql.Open("pgx", dsn)
		if e != nil {
			t.Fatal(e)
		}
		d.SetMaxOpenConns(5)
		d.SetMaxIdleConns(0)
		t.Cleanup(func() { d.Close() })
		return d
	}
	mapping, locks, competitor := open(), open(), open()
	if _, e := mapping.Exec("CREATE TABLE IF NOT EXISTS broker_whatsapp_devices (whatsapp_connection_key text primary key,device_jid text not null)"); e != nil {
		t.Fatal(e)
	}
	sm := NewSessionManager(nil, mapping, locks)
	other := NewSessionManager(nil, mapping, competitor)
	held := []*brokerLockHandle{}
	for i := 0; i < 5; i++ {
		id := string(rune('a' + i))
		c, ok, e := sm.acquireBrokerLock(context.Background(), id)
		if e != nil || !ok {
			t.Fatalf("acquire %s: %v", id, e)
		}
		held = append(held, c)
	}
	if _, ok, e := other.acquireBrokerLock(context.Background(), "a"); e != nil || ok {
		t.Fatalf("competitor lock should refuse: %v %v", ok, e)
	}
	if jid, e := sm.lookupDeviceJID(context.Background(), "absent"); e != nil || jid != "" {
		t.Fatalf("mapping starved under five real PG locks: %s %v", jid, e)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	if _, ok, e := sm.acquireBrokerLock(ctx, "sixth"); ok || e == nil {
		t.Fatal("sixth must fail bounded without raising limit")
	}
	for i, c := range held {
		releaseBrokerLockConn(c, string(rune('a'+i)))
	}
	c, ok, e := other.acquireBrokerLock(context.Background(), "a")
	if e != nil || !ok {
		t.Fatalf("released lock not reacquirable: %v", e)
	}
	releaseBrokerLockConn(c, "a")
	if locks.Stats().InUse != 0 || competitor.Stats().InUse != 0 {
		t.Fatal("connection leak after release")
	}
}

func TestSuccessWaiterAndRetryStayOffline(t *testing.T) {
	// Store.NewDevice is real, but both sessions are cancelled before runSession
	// starts, so no WhatsApp connection or callback HTTP request is made.
	state := &setupDBState{emptyMapping: true, entered: make(chan struct{}), proceed: make(chan struct{})}
	db := setupDB(t, state)
	sm := NewSessionManager(sqlstore.NewWithDB(db, "postgres", waLog.Noop), db, setupDB(t, state))
	var a, b *BrokerSession
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); a = sm.startOrGet("fixture-success", func(s *BrokerSession) { s.cancel() }) }()
	<-state.entered
	wg.Add(1)
	go func() { defer wg.Done(); b = sm.startOrGet("fixture-success", func(s *BrokerSession) { s.cancel() }) }()
	time.Sleep(10 * time.Millisecond)
	close(state.proceed)
	wg.Wait()
	sm.sessionWg.Wait()
	if a == nil || a != b || state.lookups.Load() != 1 || state.locks.Load() != 1 {
		t.Fatalf("waiter did not join success: same=%v lookups=%d locks=%d", a == b, state.lookups.Load(), state.locks.Load())
	}
	failure := &setupDBState{lookupFail: true, emptyMapping: true}
	retryDB := setupDB(t, failure)
	retry := NewSessionManager(sqlstore.NewWithDB(retryDB, "postgres", waLog.Noop), retryDB, setupDB(t, failure))
	if retry.StartOrGet("fixture-retry") != nil {
		t.Fatal("first attempt must fail")
	}
	failure.lookupFail = false
	got := retry.startOrGet("fixture-retry", func(s *BrokerSession) { s.cancel() })
	retry.sessionWg.Wait()
	if got == nil {
		t.Fatal("explicit retry after failure did not recover")
	}
	if _, ok := retry.getStartupStatus("fixture-retry"); ok {
		t.Fatal("stale startup error retained after success")
	}
}
