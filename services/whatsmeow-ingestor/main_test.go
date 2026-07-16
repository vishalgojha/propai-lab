package main

import (
	"testing"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"google.golang.org/protobuf/proto"
)

func clearDatabaseEnvironment(t *testing.T) {
	t.Helper()
	for _, key := range []string{
		"DATABASE_URL",
		"SUPABASE_DATABASE_URL",
		"SUPABASE_DB_URL",
		"SUPABASE_REF",
		"SUPABASE_DB_PASSWORD",
	} {
		t.Setenv(key, "")
	}
}

func TestResolveDatabaseURLPrefersExplicitURL(t *testing.T) {
	clearDatabaseEnvironment(t)
	t.Setenv("DATABASE_URL", "postgres://active.example/propai")
	t.Setenv("SUPABASE_DB_URL", "postgres://fallback.example/propai")

	if got := resolveDatabaseURL(); got != "postgres://active.example/propai" {
		t.Fatalf("resolveDatabaseURL() = %q", got)
	}
}

func TestResolveDatabaseURLFromSupabaseParts(t *testing.T) {
	clearDatabaseEnvironment(t)
	t.Setenv("SUPABASE_REF", "active-project")
	t.Setenv("SUPABASE_DB_PASSWORD", "secret@value")

	want := "postgres://postgres:secret%40value@db.active-project.supabase.co:5432/postgres?sslmode=require"
	if got := resolveDatabaseURL(); got != want {
		t.Fatalf("resolveDatabaseURL() = %q, want %q", got, want)
	}
}

func TestResolveDatabaseURLRequiresConfiguration(t *testing.T) {
	clearDatabaseEnvironment(t)
	if got := resolveDatabaseURL(); got != "" {
		t.Fatalf("resolveDatabaseURL() = %q, want empty", got)
	}
}

func TestMessageTextSupportsConversationAndExtendedText(t *testing.T) {
	plain := &waE2E.Message{Conversation: proto.String("  plain command  ")}
	if got := messageText(plain); got != "plain command" {
		t.Fatalf("messageText(plain) = %q", got)
	}

	extended := &waE2E.Message{
		ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("  extended command  ")},
	}
	if got := messageText(extended); got != "extended command" {
		t.Fatalf("messageText(extended) = %q", got)
	}
}
