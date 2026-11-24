package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"testing"
	"time"
)

type recoveryHangDriver struct{}
type recoveryHangConn struct{}

func (recoveryHangDriver) Open(string) (driver.Conn, error)  { return recoveryHangConn{}, nil }
func (recoveryHangConn) Prepare(string) (driver.Stmt, error) { return nil, errors.New("unused") }
func (recoveryHangConn) Begin() (driver.Tx, error)           { return nil, errors.New("unused") }
func (recoveryHangConn) Close() error                        { return nil }
func (recoveryHangConn) QueryContext(ctx context.Context, _ string, _ []driver.NamedValue) (driver.Rows, error) {
	<-ctx.Done()
	return nil, ctx.Err()
}
func TestRecoveryHungAcquireUnblocksMonitor(t *testing.T) {
	sql.Register("recoveryhang", recoveryHangDriver{})
	db, e := sql.Open("recoveryhang", "")
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	conn, e := db.Conn(context.Background())
	if e != nil {
		t.Fatal(e)
	}
	lost := false
	o := &singletonLockOwner{conn: conn, held: map[string]bool{}, onLoss: func() { lost = true }}
	start := time.Now()
	done := make(chan struct{})
	go func() { defer close(done); _, _, _ = o.acquire(context.Background(), "hang") }()
	time.Sleep(50 * time.Millisecond)
	checked := make(chan bool, 1)
	go func() { checked <- o.check(context.Background()) }()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("acquire unbounded")
	}
	select {
	case ok := <-checked:
		if ok || !lost {
			t.Fatal("not terminal")
		}
	case <-time.After(time.Second):
		t.Fatal("monitor blocked")
	}
	if time.Since(start) > 3*time.Second {
		t.Fatal("too slow")
	}
}
