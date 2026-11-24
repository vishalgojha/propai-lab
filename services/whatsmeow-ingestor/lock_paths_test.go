package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

const pathsTestDSN = "postgres://postgres@localhost/postgres?host=/tmp/propai-pairing-pg-socket&port=55441&sslmode=disable"

// Direct terminal-pairing path: the real 8s removal bound, with a session whose
// cleanup never completes. The replacement must be denied and the old session
// kept, so its broker key can never be handed to a second client.
func TestPairingTerminalReplacementBlockedFor8s(t *testing.T) {
	sm := NewSessionManager(nil, nil)
	s := sm.newSession("fixture", nil)
	s.status.ConnectionState = "pairing_error"
	sm.sessions[s.brokerID] = s
	start := time.Now()
	if got := sm.StartOrGetForQRPairing(s.brokerID); got != nil {
		t.Fatal("replacement started while old cleanup pending")
	}
	if d := time.Since(start); d < 7*time.Second || d > 10*time.Second {
		t.Fatalf("unexpected wait %v", d)
	}
	if sm.Get(s.brokerID) != s {
		t.Fatal("old session dropped")
	}
	if got := sm.StartOrGetForCodePairing(s.brokerID, "1"); got != nil {
		t.Fatal("code pairing replaced pending session")
	}
}

func TestDeleteSessionHandlerKeepsPendingStop(t *testing.T) {
	sm := NewSessionManager(nil, nil)
	s := sm.newSession("fixture", nil)
	sm.sessions[s.brokerID] = s
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/delete-session?broker_id=fixture", nil)
	sm.deleteSessionHandler(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status %d body %s", rec.Code, rec.Body.String())
	}
	var body map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if !strings.Contains(body["error"], "credentials untouched") {
		t.Fatalf("body %v", body)
	}
	if sm.Get("fixture") != s {
		t.Fatal("pending session removed")
	}
}

// Owner loss must end the real process immediately with a non-zero exit.
func TestOwnerLossExitsProcess(t *testing.T) {
	if os.Getenv("OWNER_LOSS_CHILD") == "1" {
		db, err := sql.Open("pgx", pathsTestDSN)
		if err != nil {
			os.Exit(3)
		}
		o, err := newSingletonLockOwner(context.Background(), db, func() { println("OWNER_LOSS_EXIT"); os.Exit(1) })
		if err != nil {
			os.Exit(4)
		}
		var pid int
		_ = o.conn.QueryRowContext(context.Background(), "select pg_backend_pid()").Scan(&pid)
		admin, _ := sql.Open("pgx", pathsTestDSN)
		var ok bool
		_ = admin.QueryRow("select pg_terminate_backend($1)", pid).Scan(&ok)
		go o.monitor(context.Background())
		time.Sleep(15 * time.Second)
		os.Exit(0)
	}
	cmd := exec.Command(os.Args[0], "-test.run=TestOwnerLossExitsProcess")
	cmd.Env = append(os.Environ(), "OWNER_LOSS_CHILD=1")
	start := time.Now()
	out, err := cmd.CombinedOutput()
	ee, isExit := err.(*exec.ExitError)
	if !isExit || ee.ExitCode() != 1 || !strings.Contains(string(out), "OWNER_LOSS_EXIT") {
		t.Fatalf("child did not exit via loss path: %v %s", err, out)
	}
	if time.Since(start) > 8*time.Second {
		t.Fatalf("slow exit %v", time.Since(start))
	}
}

func TestWatchStoppingFlagsOnlyHungStop(t *testing.T) {
	sm := NewSessionManager(nil, nil)
	hung := sm.newSession("hung", nil)
	fine := sm.newSession("fine", nil)
	sm.sessions["hung"], sm.sessions["fine"] = hung, fine
	hung.stopping, hung.stoppingSince = true, time.Now().Add(-time.Minute)
	fine.stopping, fine.stoppingSince = true, time.Now().Add(-time.Minute)
	close(fine.done)
	got := make(chan string, 2)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go sm.watchStopping(ctx, 10*time.Second, 10*time.Millisecond, func(id string, _ time.Duration) { got <- id })
	select {
	case id := <-got:
		if id != "hung" {
			t.Fatal(id)
		}
	case <-time.After(time.Second):
		t.Fatal("hung stop not flagged")
	}
	if sm.Get("hung") != hung {
		t.Fatal("hung session released early")
	}
}

func TestDisconnectHandlerKeeps200AndReportsPending(t *testing.T) {
	sm := NewSessionManager(nil, nil)
	s := sm.newSession("fixture", nil)
	sm.sessions[s.brokerID] = s
	rec := httptest.NewRecorder()
	sm.disconnectHandler(rec, httptest.NewRequest(http.MethodPost, "/disconnect?broker_id=fixture", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	var body map[string]interface{}
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body["ok"] != true || body["stop_confirmed"] != false || body["state"] != "stopping" {
		t.Fatalf("body %v", body)
	}
	if sm.Get("fixture") != s {
		t.Fatal("session removed before done")
	}
	close(s.done)
	for i := 0; i < 100 && sm.Get("fixture") != nil; i++ {
		time.Sleep(10 * time.Millisecond)
	}
	if sm.Get("fixture") != nil {
		t.Fatal("not removed after done")
	}
}
