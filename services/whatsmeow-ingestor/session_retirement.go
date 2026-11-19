package main

import (
	"context"
	"errors"
)

// Event admission and reset use the same mutex, so Wait cannot race a new Add.
// Work already spawned to ingest historical messages is not credential setup.
func (s *BrokerSession) admitSessionEvent() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.resetting || (s.ctx != nil && s.ctx.Err() != nil) {
		return false
	}
	s.eventWg.Add(1)
	return true
}
func (s *BrokerSession) drainSessionEvents(ctx context.Context) error {
	done := make(chan struct{})
	go func() { s.eventWg.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (s *BrokerSession) retireLoop(ctx context.Context) error {
	if s.cancel != nil {
		s.cancel()
	}
	if s.loopDone == nil {
		return errors.New("session lifetime cannot be verified")
	}
	select {
	case <-s.loopDone:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
