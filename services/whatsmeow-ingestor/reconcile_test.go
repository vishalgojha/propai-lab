package main

import "testing"

func TestReconcileAction(t *testing.T) {
	cases := []struct {
		name          string
		sessionExists bool
		intentional   bool
		paired        bool
		want          string
	}{
		{"running session is left alone", true, false, true, "skip-running"},
		{"running session wins over every other state", true, true, false, "skip-running"},
		{"explicit owner disconnect is never auto-restarted", false, true, true, "skip-intentional-disconnect"},
		{"unpaired mapped device is never auto-started", false, false, false, "skip-unpaired"},
		{"intentional disconnect wins over unpaired", false, true, false, "skip-intentional-disconnect"},
		{"mapped paired idle session is started", false, false, true, "start"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := reconcileAction(tc.sessionExists, tc.intentional, tc.paired); got != tc.want {
				t.Fatalf("reconcileAction(%v, %v, %v) = %q, want %q", tc.sessionExists, tc.intentional, tc.paired, got, tc.want)
			}
		})
	}
}

func TestIntentionalDisconnectMarkClearIs(t *testing.T) {
	sm := &SessionManager{intentionalDisconnects: map[string]bool{}}
	if sm.isIntentionalDisconnect("phone-x") {
		t.Fatal("unmarked broker reported as intentional disconnect")
	}
	sm.markIntentionalDisconnect("phone-x")
	if !sm.isIntentionalDisconnect("phone-x") {
		t.Fatal("marked broker not reported as intentional disconnect")
	}
	if sm.isIntentionalDisconnect("phone-y") {
		t.Fatal("marking one broker marked another")
	}
	sm.clearIntentionalDisconnect("phone-x")
	if sm.isIntentionalDisconnect("phone-x") {
		t.Fatal("cleared broker still reported as intentional disconnect")
	}
	// Clearing an unmarked broker and marking on a nil map must not panic.
	sm.clearIntentionalDisconnect("phone-never-marked")
	sm2 := &SessionManager{}
	sm2.markIntentionalDisconnect("phone-z")
	if !sm2.isIntentionalDisconnect("phone-z") {
		t.Fatal("mark on nil map did not initialize")
	}
}
