package main

import "testing"

func TestRecoveryLockConfigFailsClosed(t *testing.T) {
	for _, x := range []struct {
		url, mode string
		ok        bool
	}{{"", "", false}, {"postgres://u:p@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres", "session", false}, {"postgres://u:p@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres", "session", true}, {"postgres://u:p@localhost:5432/postgres", "direct", true}} {
		t.Setenv("PROPAI_SESSION_LOCK_DATABASE_URL", x.url)
		t.Setenv("PROPAI_SESSION_LOCK_DATABASE_MODE", x.mode)
		_, e := resolveSessionLockDatabaseURL()
		if (e == nil) != x.ok {
			t.Fatal(x.mode, e)
		}
	}
}
