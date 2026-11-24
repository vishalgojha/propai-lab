package main

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"strings"
)

// Session locks must never share a transaction-pool DSN with short queries.
// The operator must supply a provider-verified endpoint and explicit mode.
// This validates configuration; it does not authenticate pooler behavior.
func resolveSessionLockDatabaseURL() (string, error) {
	raw := strings.TrimSpace(os.Getenv("PROPAI_SESSION_LOCK_DATABASE_URL"))
	mode := strings.TrimSpace(os.Getenv("PROPAI_SESSION_LOCK_DATABASE_MODE"))
	if raw == "" {
		return "", errors.New("PROPAI_SESSION_LOCK_DATABASE_URL is required: use a provider-verified session or direct endpoint")
	}
	if mode != "session" && mode != "direct" {
		return "", errors.New("PROPAI_SESSION_LOCK_DATABASE_MODE must explicitly be session or direct")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		return "", errors.New("invalid session-lock database URL")
	}
	if strings.HasSuffix(strings.ToLower(u.Hostname()), ".supabase.com") || strings.HasSuffix(strings.ToLower(u.Hostname()), ".supabase.co") {
		if u.Port() == "6543" {
			return "", errors.New("Supabase port6543 is transaction pooled and cannot own session advisory locks")
		}
	}
	q := u.Query()
	q.Set("default_query_exec_mode", "simple_protocol")
	u.RawQuery = q.Encode()
	if mode == "session" && strings.HasPrefix(strings.ToLower(u.Hostname()), "db.") && strings.HasSuffix(strings.ToLower(u.Hostname()), ".supabase.co") {
		return "", fmt.Errorf("mode session does not match a Supabase direct hostname; verify provider settings")
	}
	return u.String(), nil
}
