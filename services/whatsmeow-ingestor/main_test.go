package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

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

func TestPostWebhookPayloadRejectsNonSuccessResponse(t *testing.T) {
	previousClient := webhookHTTPClient
	webhookHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("Content-Type") != "application/json" {
			t.Fatalf("unexpected content type: %s", r.Header.Get("Content-Type"))
		}
		body, _ := io.ReadAll(r.Body)
		if string(body) != `{"event":"test"}` {
			t.Fatalf("unexpected payload: %s", body)
		}
		return &http.Response{
			StatusCode: http.StatusServiceUnavailable,
			Body:       io.NopCloser(strings.NewReader("try later")),
			Header:     make(http.Header),
		}, nil
	})}
	defer func() { webhookHTTPClient = previousClient }()

	if err := postWebhookPayload([]byte(`{"event":"test"}`)); err == nil {
		t.Fatal("expected non-2xx webhook response to fail")
	}
}

func TestPostWebhookPayloadAcceptsSuccessResponse(t *testing.T) {
	previousClient := webhookHTTPClient
	webhookHTTPClient = &http.Client{Transport: roundTripFunc(func(_ *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusAccepted,
			Body:       io.NopCloser(strings.NewReader("")),
			Header:     make(http.Header),
		}, nil
	})}
	defer func() { webhookHTTPClient = previousClient }()

	if err := postWebhookPayload([]byte(`{"event":"test"}`)); err != nil {
		t.Fatalf("postWebhookPayload() error = %v", err)
	}
}

func TestMediaPathHelpers(t *testing.T) {
	if got := extensionForMIME("image/jpeg; charset=binary"); got != ".jpg" {
		t.Fatalf("extensionForMIME() = %q", got)
	}
	if got := safePathPart("group/name"); got == "group/name" {
		t.Fatalf("safePathPart() did not escape slash: %q", got)
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

func TestPairedQRSessionIsKeptAlive(t *testing.T) {
	if !shouldRetryQRPairing(nil) || !shouldRetryQRPairing(&store.Device{}) {
		t.Fatal("unpaired devices must retry QR pairing")
	}
	jid := types.NewJID("919773757759", types.DefaultUserServer)
	if shouldRetryQRPairing(&store.Device{ID: &jid}) {
		t.Fatal("paired QR session must stay connected instead of being recreated")
	}
}

func TestOwnWhatsAppJIDAcceptsPhoneAndLIDAddresses(t *testing.T) {
	phone := types.NewJID("919773757759", types.DefaultUserServer)
	phone.Device = 41
	lid := types.NewJID("123456789012345", types.HiddenUserServer)
	session := &BrokerSession{client: &whatsmeow.Client{Store: &store.Device{ID: &phone, LID: lid}}}

	if !isOwnWhatsAppJID(session, phone.ToNonAD()) {
		t.Fatal("own phone-number JID was not recognized")
	}
	if !isOwnWhatsAppJID(session, lid) {
		t.Fatal("own LID was not recognized")
	}
	other := types.NewJID("919999999999", types.DefaultUserServer)
	if isOwnWhatsAppJID(session, other) {
		t.Fatal("unrelated phone was incorrectly recognized as self-chat")
	}
}

func TestSelfChatCommandAcceptsOwnLIDAndRejectsLocalBotEcho(t *testing.T) {
	phone := types.NewJID("919773757759", types.DefaultUserServer)
	lid := types.NewJID("123456789012345", types.HiddenUserServer)
	session := &BrokerSession{client: &whatsmeow.Client{Store: &store.Device{ID: &phone, LID: lid}}}
	evt := &events.Message{
		Info: types.MessageInfo{
			MessageSource:  types.MessageSource{IsFromMe: true},
			ID:             "human-command",
			DeviceSentMeta: &types.DeviceSentMeta{DestinationJID: lid.String()},
		},
		Message: &waE2E.Message{Conversation: proto.String("find options")},
	}

	target, text, ok := selfChatCommand(session, evt)
	if !ok || target != lid || text != "find options" {
		t.Fatalf("selfChatCommand() = target %s text %q ok %v", target, text, ok)
	}
	evt.Info.DeviceSentMeta = nil
	if _, _, ok := selfChatCommand(session, evt); ok {
		t.Fatal("locally generated bot echo must not trigger another self-chat reply")
	}
}

func TestInternalOnlyRejectsMissingToken(t *testing.T) {
	t.Setenv("PROPAI_INTERNAL_TOKEN", "expected-token")
	called := false
	handler := internalOnly(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusNoContent)
	}, false)

	recorder := httptest.NewRecorder()
	handler(recorder, httptest.NewRequest(http.MethodPost, "/connect", nil))
	if recorder.Code != http.StatusUnauthorized || called {
		t.Fatalf("status=%d called=%v", recorder.Code, called)
	}
}

func TestInternalOnlyAcceptsValidToken(t *testing.T) {
	t.Setenv("PROPAI_INTERNAL_TOKEN", "expected-token")
	handler := internalOnly(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}, false)

	request := httptest.NewRequest(http.MethodPost, "/connect", nil)
	request.Header.Set("X-PropAI-Internal-Token", "expected-token")
	recorder := httptest.NewRecorder()
	handler(recorder, request)
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("status=%d", recorder.Code)
	}
}

func TestHealthAllowsMinimalPublicLiveness(t *testing.T) {
	t.Setenv("PROPAI_INTERNAL_TOKEN", "expected-token")
	handler := internalOnly(func(http.ResponseWriter, *http.Request) {
		t.Fatal("protected health handler should not run")
	}, true)

	recorder := httptest.NewRecorder()
	handler(recorder, httptest.NewRequest(http.MethodGet, "/health", nil))
	var body map[string]interface{}
	if err := json.NewDecoder(recorder.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if recorder.Code != http.StatusOK || body["ok"] != true || body["broker_id"] != nil {
		t.Fatalf("status=%d body=%v", recorder.Code, body)
	}
}
