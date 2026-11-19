package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"sync"
	"time"
)

// One physical session owns the singleton plus all legacy broker lock keys.
// This reduces connection demand, not workload demand. It is not fencing for
// WhatsApp: detection has a finite delay, so operational stop-before-start is
// mandatory. Ownership uncertainty is terminal; never reconnect this owner.
const ingestorOwnerKey int64 = -687204371294

type singletonLockOwner struct {
	mu     sync.Mutex
	conn   *sql.Conn
	held   map[string]bool
	lost   bool
	onLoss func()
}

type brokerLockHandle struct {
	conn  *sql.Conn // bounded legacy implementation retained for comparison tests
	owner *singletonLockOwner
}

func newSingletonLockOwner(ctx context.Context, db *sql.DB, onLoss func()) (*singletonLockOwner, error) {
	if onLoss == nil {
		return nil, errors.New("ownership loss must terminate service")
	}
	conn, err := db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	var ok bool
	if err = conn.QueryRowContext(ctx, "SELECT pg_try_advisory_lock($1)", ingestorOwnerKey).Scan(&ok); err != nil {
		_ = conn.Raw(func(any) error { return driver.ErrBadConn })
		_ = conn.Close()
		return nil, err
	}
	if !ok {
		_ = conn.Close()
		return nil, errors.New("another singleton ingestor owns the service lock")
	}
	return &singletonLockOwner{conn: conn, held: map[string]bool{}, onLoss: onLoss}, nil
}

// Caller holds mu. In production onLoss exits the process synchronously.
func (o *singletonLockOwner) failLocked() {
	if o.lost {
		return
	}
	o.lost = true
	_ = o.conn.Raw(func(any) error { return driver.ErrBadConn })
	_ = o.conn.Close()
	o.onLoss()
}
func (o *singletonLockOwner) acquire(ctx context.Context, id string) (*brokerLockHandle, bool, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.lost {
		return nil, false, errors.New("singleton ownership lost")
	}
	if o.held[id] {
		return nil, false, nil
	} // PG locks are reentrant, do not leak counts.
	var ok bool
	if err := o.conn.QueryRowContext(ctx, "SELECT pg_try_advisory_lock($1)", brokerLockKey(id)).Scan(&ok); err != nil {
		o.failLocked()
		return nil, false, err
	}
	if !ok {
		return nil, false, nil
	}
	o.held[id] = true
	return &brokerLockHandle{owner: o}, true, nil
}
func (o *singletonLockOwner) release(id string) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.lost || !o.held[id] {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var ok bool
	if err := o.conn.QueryRowContext(ctx, "SELECT pg_advisory_unlock($1)", brokerLockKey(id)).Scan(&ok); err != nil || !ok {
		o.failLocked()
		return false
	}
	delete(o.held, id)
	return true
}
func (o *singletonLockOwner) check(ctx context.Context) bool {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.lost {
		return false
	}
	// Query the held lock itself. A successful ping alone proves only connectivity.
	var ok bool
	err := o.conn.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid() AND classid=(($1::bigint >> 32) & 4294967295)::oid AND objid=($1::bigint & 4294967295)::oid AND objsubid=1 AND granted)`, ingestorOwnerKey).Scan(&ok)
	if err != nil || !ok {
		o.failLocked()
		return false
	}
	return true
}
func (o *singletonLockOwner) monitor(ctx context.Context) {
	tick := time.NewTicker(2 * time.Second)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
			qctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			ok := o.check(qctx)
			cancel()
			if !ok {
				return
			}
		}
	}
}
func (o *singletonLockOwner) close() {
	o.mu.Lock()
	defer o.mu.Unlock()
	// Always discard physical backend. Returning a connection to a pool does not
	// release its remaining session locks. Only called after sessions have stopped.
	if !o.lost {
		o.lost = true
		_ = o.conn.Raw(func(any) error { return driver.ErrBadConn })
		_ = o.conn.Close()
	}
}
