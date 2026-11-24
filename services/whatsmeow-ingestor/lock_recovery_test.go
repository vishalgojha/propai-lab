package main

import (
	"context"
	"database/sql"
	_ "github.com/jackc/pgx/v5/stdlib"
	"testing"
	"time"
)

func TestOwnerSevenBrokersSeparateMappingAndRelease(t *testing.T) {
	dsn := "postgres://postgres@localhost/postgres?host=/tmp/propai-pairing-pg-socket&port=55441&sslmode=disable"
	locks, e := sql.Open("pgx", dsn)
	if e != nil {
		t.Fatal(e)
	}
	defer locks.Close()
	locks.SetMaxOpenConns(1)
	mapping, e := sql.Open("pgx", dsn)
	if e != nil {
		t.Fatal(e)
	}
	defer mapping.Close()
	mapping.SetMaxOpenConns(1)
	lost := false
	o, e := newSingletonLockOwner(context.Background(), locks, func() { lost = true })
	if e != nil {
		t.Fatal(e)
	}
	defer o.close()
	sm := NewSessionManager(nil, mapping)
	sm.lockOwner = o
	for _, id := range []string{"a", "b", "c", "d", "e", "f", "g"} {
		_, ok, e := sm.acquireBrokerLock(context.Background(), id)
		if e != nil || !ok {
			t.Fatal(id, e)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	var n int
	if e = mapping.QueryRowContext(ctx, "select 1").Scan(&n); e != nil {
		t.Fatal(e)
	}
	if !o.check(ctx) || lost {
		t.Fatal("lost healthy owner")
	}
	if locks.Stats().InUse != 1 {
		t.Fatal(locks.Stats())
	}
	t.Log("seven broker locks one owner connection, independent mapping query succeeds")
	var pid int
	if e := o.conn.QueryRowContext(ctx, "select pg_backend_pid()").Scan(&pid); e != nil {
		t.Fatal(e)
	}
	var terminated bool
	if e := mapping.QueryRowContext(ctx, "select pg_terminate_backend($1)", pid).Scan(&terminated); e != nil || !terminated {
		t.Fatalf("terminate test backend: %v %v", terminated, e)
	}
	if o.check(ctx) || !lost {
		t.Fatal("lost backend did not fail closed")
	}
	if _, ok, e := sm.acquireBrokerLock(ctx, "later"); e == nil || ok {
		t.Fatal("silently reconnected")
	}

}
func TestRecoveryOwnerCleanHandover(t *testing.T) {
	dsn := "postgres://postgres@localhost/postgres?host=/tmp/propai-pairing-pg-socket&port=55441&sslmode=disable"
	a, e := sql.Open("pgx", dsn)
	if e != nil {
		t.Fatal(e)
	}
	defer a.Close()
	b, e := sql.Open("pgx", dsn)
	if e != nil {
		t.Fatal(e)
	}
	defer b.Close()
	o, e := newSingletonLockOwner(context.Background(), a, func() {})
	if e != nil {
		t.Fatal(e)
	}
	if other, e := newSingletonLockOwner(context.Background(), b, func() {}); e == nil {
		other.close()
		t.Fatal("duplicate owner")
	}
	h, ok, e := o.acquire(context.Background(), "fixture")
	if e != nil || !ok {
		t.Fatal(e)
	}
	releaseBrokerLockConn(h, "fixture")
	if !o.check(context.Background()) {
		t.Fatal("release lost singleton")
	}
	o.close()
	// The server tears down a discarded backend asynchronously; allow it a
	// bounded moment before declaring the handover failed.
	var n *singletonLockOwner
	for i := 0; i < 100; i++ {
		n, e = newSingletonLockOwner(context.Background(), b, func() {})
		if e == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if e != nil {
		t.Fatal(e)
	}
	n.close()
}
func TestRecoveryLegacyConflictCancelAndEightRelease(t *testing.T) {
	dsn := "postgres://postgres@localhost/postgres?host=/tmp/propai-pairing-pg-socket&port=55441&sslmode=disable"
	a, e := sql.Open("pgx", dsn)
	if e != nil {
		t.Fatal(e)
	}
	defer a.Close()
	b, e := sql.Open("pgx", dsn)
	if e != nil {
		t.Fatal(e)
	}
	defer b.Close()
	b.SetMaxOpenConns(1)
	b.SetMaxIdleConns(1)
	var ok bool
	if e = b.QueryRow("select pg_try_advisory_lock($1)", brokerLockKey("legacy")).Scan(&ok); e != nil || !ok {
		t.Fatal(e)
	}
	lost := false
	o, e := newSingletonLockOwner(context.Background(), a, func() { lost = true })
	if e != nil {
		t.Fatal(e)
	}
	defer o.close()
	if _, ok, e = o.acquire(context.Background(), "legacy"); e != nil || ok || lost {
		t.Fatal("legacy conflict not safe", e)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, ok, e = o.acquire(ctx, "cancelled"); e == nil || ok || lost {
		t.Fatal("presend cancel marked lost")
	}
	for _, id := range []string{"a", "b", "c", "d", "e", "f", "g", "h"} {
		if _, ok, e = o.acquire(context.Background(), id); e != nil || !ok {
			t.Fatal(e)
		}
	}
	for _, id := range []string{"a", "b", "c", "d", "e", "f", "g", "h"} {
		if !o.release(id) {
			t.Fatal(id)
		}
	}
	if !o.check(context.Background()) {
		t.Fatal("releases lost singleton")
	}
	o.close()
	n, e := newSingletonLockOwner(context.Background(), a, func() {})
	if e != nil {
		t.Fatal(e)
	}
	defer n.close()
	for _, id := range []string{"a", "b", "c", "d", "e", "f", "g", "h"} {
		if _, ok, e = n.acquire(context.Background(), id); e != nil || !ok {
			t.Fatal("handover", id, e)
		}
	}
	if e := b.QueryRow("select pg_advisory_unlock($1)", brokerLockKey("legacy")).Scan(&ok); e != nil || !ok {
		t.Fatal("legacy unlock", e)
	}
}
