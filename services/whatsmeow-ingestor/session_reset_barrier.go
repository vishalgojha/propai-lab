package main

import (
	"context"
	"errors"
)

// beginReset establishes an exclusive destructive-operation barrier. Existing
// setup is cancelled and joined before credentials are examined or deleted.
// New starts fail closed while the barrier is held. This is process-local and
// depends on the explicitly required singleton ingestor topology.
func (sm *SessionManager) beginReset(ctx context.Context, brokerID string) (func(), error) {
	sm.mu.Lock()
	if sm.resetting == nil {
		sm.resetting = make(map[string]bool)
	}
	if sm.resetting[brokerID] {
		sm.mu.Unlock()
		return nil, errors.New("reset already running")
	}
	sm.resetting[brokerID] = true
	existing := sm.sessions[brokerID]
	if s := existing; s != nil {
		s.mu.Lock()
		s.resetting = true
		s.mu.Unlock()
	}
	done := sm.starting[brokerID]
	cancel := sm.startupCancel[brokerID]
	sm.mu.Unlock()
	finish := func() {
		sm.mu.Lock()
		delete(sm.resetting, brokerID)
		delete(sm.startupStatus, brokerID)
		sm.mu.Unlock()
	}
	if cancel != nil {
		cancel()
	}
	if done != nil {
		select {
		case <-done:
		case <-ctx.Done():
			finish()
			return nil, ctx.Err()
		}
	}
	if existing != nil {
		if err := existing.drainSessionEvents(ctx); err != nil {
			finish()
			return nil, err
		}
	}
	return finish, nil
}
