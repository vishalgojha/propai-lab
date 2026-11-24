package main

import (
	"context"
	"os"
	"os/exec"
	"testing"
	"time"
)

func TestRecoveryRemoveWaitsAndTimeoutRetains(t *testing.T) {
	sm := NewSessionManager(nil, nil)
	s := sm.newSession("fixture", nil)
	sm.sessions[s.brokerID] = s
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if sm.removeSession(ctx, s.brokerID, s) {
		t.Fatal("removed before done")
	}
	if sm.Get(s.brokerID) != s {
		t.Fatal("lost pending session")
	}
	if sm.StartOrGet(s.brokerID) != nil {
		t.Fatal("replacement allowed")
	}
	close(s.done)
	if !sm.Remove(s.brokerID) || sm.Get(s.brokerID) != nil {
		t.Fatal("completed session retained")
	}
}
func TestRecoveryPairingDoesNotReplacePendingStop(t *testing.T) {
	sm := NewSessionManager(nil, nil)
	s := sm.newSession("fixture", nil)
	s.status.ConnectionState = "pairing_error"
	sm.sessions[s.brokerID] = s
	s.stopping = true
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	if sm.removeSession(ctx, s.brokerID, s) {
		t.Fatal("pending stop passed")
	}
	sm.shuttingDown = true
	close(s.done)
	if sm.StartOrGetForQRPairing(s.brokerID) != nil {
		t.Fatal("pairing started during shutdown")
	}
}
func TestRecoveryShutdownRefusesStarts(t *testing.T) {
	sm := NewSessionManager(nil, nil)
	sm.shuttingDown = true
	close(sm.shutdownCh)
	if sm.StartOrGet("fixture") != nil {
		t.Fatal("started during shutdown")
	}
	sm.restoreSessionWhenAvailable("fixture")
	if len(sm.restoring) != 0 {
		t.Fatal("restore started during shutdown")
	}
}

func TestFinishSessionOrderDisconnectReleaseDone(t *testing.T) {
	sm := NewSessionManager(nil, nil)
	s := sm.newSession("fixture", nil)
	var steps []string
	s.testStep = func(x string) {
		select {
		case <-s.done:
			t.Errorf("done closed before step %s", x)
		default:
		}
		steps = append(steps, x)
	}
	s.finishSession()
	select {
	case <-s.done:
	default:
		t.Fatal("done not closed")
	}
	if len(steps) != 2 || steps[0] != "disconnected" || steps[1] != "released" {
		t.Fatalf("order %v", steps)
	}
}

func TestRemoveBlockedStopKeepsSessionThenCompletes(t *testing.T) {
	sm := NewSessionManager(nil, nil)
	s := sm.newSession("fixture", nil)
	sm.sessions[s.brokerID] = s
	release := make(chan struct{})
	go func() { <-release; s.finishSession() }() // simulates a Disconnect that is still in progress
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if sm.removeSession(ctx, s.brokerID, s) {
		t.Fatal("reported stop while cleanup still pending")
	}
	if sm.Get(s.brokerID) != s || sm.StartOrGet(s.brokerID) != nil {
		t.Fatal("pending session lost or replaced")
	}
	close(release)
	ok := false
	for i := 0; i < 100 && !ok; i++ {
		ok = sm.Remove(s.brokerID)
		time.Sleep(5 * time.Millisecond)
	}
	if !ok || sm.Get(s.brokerID) != nil {
		t.Fatal("not removed after cleanup completed")
	}
}

func TestStartupFatalBackoffSubprocess(t *testing.T) {
	if os.Getenv("STARTUP_FATAL_CHILD") == "1" {
		startupFatalBackoff = 700 * time.Millisecond
		startupFatalf("simulated %s", "failure")
		return
	}
	cmd := exec.Command(os.Args[0], "-test.run=TestStartupFatalBackoffSubprocess")
	cmd.Env = append(os.Environ(), "STARTUP_FATAL_CHILD=1")
	start := time.Now()
	err := cmd.Run()
	if err == nil {
		t.Fatal("child exited cleanly")
	}
	if time.Since(start) < 600*time.Millisecond {
		t.Fatalf("no backoff before exit: %v", time.Since(start))
	}
}
