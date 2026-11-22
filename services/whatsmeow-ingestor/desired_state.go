package main

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"time"
)

// Durable owner intent for whether a mapped broker session should be running.
//
// Today nothing records a transport-level disconnect: /disconnect removes the
// in-memory session but keeps the device mapping, so after a process restart
// a deliberately disconnected broker is indistinguishable from one dropped by
// a crash. This table closes that gap going forward. It is additive only:
// no existing rows or tables are changed, and unknown (absent) state is
// always treated as "do not auto-start" — never as permission.
const (
	desiredStateRunning = "running"
	desiredStateStopped = "stopped"
)

// ensureDesiredStateTable creates the intent table if absent. Idempotent and
// additive; on failure the reconciler stays disabled rather than guessing.
func ensureDesiredStateTable(db *sql.DB) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS broker_session_desired_state (
		whatsapp_connection_key text primary key,
		desired_state text not null,
		updated_at timestamptz not null default now()
	)`)
	return err
}

// recordDesiredState is the single choke point for durable intent writes.
// Tests inject SessionManager.desiredStateWriter to control and block writes;
// production always uses setDesiredState.
func (sm *SessionManager) recordDesiredState(brokerID, state string) {
	if w := sm.desiredStateWriter; w != nil {
		w(brokerID, state)
		return
	}
	sm.setDesiredState(brokerID, state)
}

// setDesiredState records the latest observed owner intent. It never deletes
// anything and failures are logged, not fatal.
func (sm *SessionManager) setDesiredState(brokerID, state string) {
	if sm.db == nil {
		log.Printf("[broker %s] desired-state write skipped: no db handle", brokerID)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if _, err := sm.db.ExecContext(ctx,
		`INSERT INTO broker_session_desired_state (whatsapp_connection_key, desired_state, updated_at)
		 VALUES ($1, $2, NOW())
		 ON CONFLICT (whatsapp_connection_key) DO UPDATE SET desired_state=$2, updated_at=NOW()`,
		brokerID, state); err != nil {
		log.Printf("[broker %s] desired-state write failed: %v", brokerID, err)
	}
}

// deleteDesiredState accompanies mapping deletion (reset/delete-session):
// the broker's identity is gone, so its intent record goes with it.
func (sm *SessionManager) deleteDesiredState(brokerID string) {
	if sm.db == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if _, err := sm.db.ExecContext(ctx,
		"DELETE FROM broker_session_desired_state WHERE whatsapp_connection_key=$1", brokerID); err != nil {
		log.Printf("[broker %s] desired-state delete failed: %v", brokerID, err)
	}
}

// desiredStates loads every recorded intent row, keyed by broker.
func (sm *SessionManager) desiredStates(ctx context.Context) (map[string]string, error) {
	if sm.db == nil {
		return nil, fmt.Errorf("no db handle")
	}
	rows, err := sm.db.QueryContext(ctx, "SELECT whatsapp_connection_key, desired_state FROM broker_session_desired_state")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var key, state string
		if err := rows.Scan(&key, &state); err != nil {
			return nil, err
		}
		out[key] = state
	}
	return out, rows.Err()
}
