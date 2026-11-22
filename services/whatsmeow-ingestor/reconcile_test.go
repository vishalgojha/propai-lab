package main

import (
	"context"
	"database/sql"
	"os"
	"testing"
)

func TestReconcileAction(t *testing.T) {
	cases := []struct {
		name          string
		sessionExists bool
		desiredState  string
		paired        bool
		want          string
	}{
		{"running session is left alone", true, desiredStateRunning, true, "skip-running"},
		{"running session wins over every other state", true, desiredStateStopped, false, "skip-running"},
		{"explicit owner stop is never auto-restarted", false, desiredStateStopped, true, "skip-no-durable-want"},
		{"unknown intent is never auto-started", false, "", true, "skip-no-durable-want"},
		{"garbage intent value is never auto-started", false, "maybe", true, "skip-no-durable-want"},
		{"unpaired mapped device is never auto-started even with running intent", false, desiredStateRunning, false, "skip-unpaired"},
		{"stop intent wins over unpaired", false, desiredStateStopped, false, "skip-no-durable-want"},
		{"mapped paired idle session with durable running intent is started", false, desiredStateRunning, true, "start"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := reconcileAction(tc.sessionExists, tc.desiredState, tc.paired); got != tc.want {
				t.Fatalf("reconcileAction(%v, %q, %v) = %q, want %q", tc.sessionExists, tc.desiredState, tc.paired, got, tc.want)
			}
		})
	}
}

// The reconciler must do nothing at all until the durable intent table has
// been ensured at startup.
func TestReconcilerDisabledWithoutDesiredStateTable(t *testing.T) {
	sm := &SessionManager{}
	if sm.reconcileEnabled.Load() {
		t.Fatal("reconcileEnabled must default to false")
	}
	// reconcileMappedSessions with a nil db would panic if it touched the
	// database; with the gate off it must return without any DB access.
	sm.reconcileMappedSessions(t.Context())
}

// Desired-state round trip against a real Postgres, mirroring the existing
// *_postgres_test.go pattern: skipped unless a disposable DSN is provided.
func TestDesiredStateRoundTrip(t *testing.T) {
	dsn := os.Getenv("PROPAI_TEST_LOCAL_PG_DSN")
	if dsn == "" {
		t.Skip("disposable PG not configured")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatalf("open disposable PG: %v", err)
	}
	defer db.Close()
	if err := db.PingContext(context.Background()); err != nil {
		t.Fatalf("ping disposable PG: %v", err)
	}

	if err := ensureDesiredStateTable(db); err != nil {
		t.Fatalf("ensureDesiredStateTable: %v", err)
	}
	// Idempotent: second call must also succeed.
	if err := ensureDesiredStateTable(db); err != nil {
		t.Fatalf("ensureDesiredStateTable second call: %v", err)
	}

	sm := &SessionManager{db: db}
	ctx := t.Context()

	states, err := sm.desiredStates(ctx)
	if err != nil {
		t.Fatalf("desiredStates on empty table: %v", err)
	}
	if len(states) != 0 {
		t.Fatalf("expected no rows, got %v", states)
	}

	sm.setDesiredState("phone-a", desiredStateRunning)
	sm.setDesiredState("phone-b", desiredStateStopped)
	// Upsert: latest write wins.
	sm.setDesiredState("phone-a", desiredStateStopped)

	states, err = sm.desiredStates(ctx)
	if err != nil {
		t.Fatalf("desiredStates: %v", err)
	}
	if states["phone-a"] != desiredStateStopped {
		t.Fatalf("phone-a = %q, want stopped (upsert)", states["phone-a"])
	}
	if states["phone-b"] != desiredStateStopped {
		t.Fatalf("phone-b = %q, want stopped", states["phone-b"])
	}

	sm.deleteDesiredState("phone-a")
	states, err = sm.desiredStates(ctx)
	if err != nil {
		t.Fatalf("desiredStates after delete: %v", err)
	}
	if _, ok := states["phone-a"]; ok {
		t.Fatal("phone-a still present after deleteDesiredState")
	}
	if states["phone-b"] != desiredStateStopped {
		t.Fatal("deleteDesiredState removed the wrong broker")
	}
}
