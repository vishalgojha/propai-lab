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

func TestFireWebhookSendsToEndpoint(t *testing.T) {
	previousClient := httpClient
	var received []byte
	httpClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		received, _ = io.ReadAll(r.Body)
		return &http.Response{
			StatusCode: http.StatusAccepted,
			Body:       io.NopCloser(strings.NewReader("")),
			Header:     make(http.Header),
		}, nil
	})}
	defer func() { httpClient = previousClient }()

	fireWebhook(map[string]interface{}{"event": "test"})
	if string(received) != `{"event":"test"}` {
		t.Fatalf("unexpected payload: %s", received)
	}
}

func TestFireWebhookLogsNonSuccessResponse(t *testing.T) {
	previousClient := httpClient
	httpClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusServiceUnavailable,
			Body:       io.NopCloser(strings.NewReader("try later")),
			Header:     make(http.Header),
		}, nil
	})}
	defer func() { httpClient = previousClient }()

	fireWebhook(map[string]interface{}{"event": "test"})
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

func TestSelfChatCommandAcceptsOwnJIDAndLID(t *testing.T) {
	phone := types.NewJID("919773757759", types.DefaultUserServer)
	lid := types.NewJID("123456789012345", types.HiddenUserServer)
	session := &BrokerSession{client: &whatsmeow.Client{Store: &store.Device{ID: &phone, LID: lid}}}

	// Self-chat directed at the phone-number JID (no DeviceSentMeta needed)
	evt := &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{
				IsFromMe: true,
				Chat:     phone,
			},
			ID: "human-command-phone",
		},
		Message: &waE2E.Message{Conversation: proto.String("find options")},
	}
	target, text, ok := selfChatCommand(session, evt)
	if !ok || target != phone.ToNonAD() || text != "find options" {
		t.Fatalf("selfChatCommand(phone) = target %s text %q ok %v", target, text, ok)
	}

	// Self-chat directed at the LID
	evt2 := &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{
				IsFromMe: true,
				Chat:     lid,
			},
			ID: "human-command-lid",
		},
		Message: &waE2E.Message{Conversation: proto.String("list properties")},
	}
	target2, text2, ok2 := selfChatCommand(session, evt2)
	if !ok2 || target2 != lid.ToNonAD() || text2 != "list properties" {
		t.Fatalf("selfChatCommand(lid) = target %s text %q ok %v", target2, text2, ok2)
	}

	// Message to a different number must NOT trigger self-chat
	other := types.NewJID("919999999999", types.DefaultUserServer)
	evt3 := &events.Message{
		Info: types.MessageInfo{
			MessageSource: types.MessageSource{
				IsFromMe: true,
				Chat:     other,
			},
			ID: "other-person",
		},
		Message: &waE2E.Message{Conversation: proto.String("hello")},
	}
	if _, _, ok3 := selfChatCommand(session, evt3); ok3 {
		t.Fatal("message to another number must not trigger self-chat")
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

func TestMessageTextExtractsMediaCaptions(t *testing.T) {
	imageWithCaption := &waE2E.Message{
		ImageMessage: &waE2E.ImageMessage{
			Mimetype: proto.String("image/jpeg"),
			Caption:  proto.String("2BHK Worli 1.2Cr call Rohan"),
		},
	}
	if got := messageText(imageWithCaption); got != "2BHK Worli 1.2Cr call Rohan" {
		t.Fatalf("messageText(image + caption) = %q", got)
	}

	imageWithoutCaption := &waE2E.Message{
		ImageMessage: &waE2E.ImageMessage{Mimetype: proto.String("image/jpeg")},
	}
	if got := messageText(imageWithoutCaption); got != "📷 Photo" {
		t.Fatalf("messageText(image no caption) = %q", got)
	}

	imageCaptionTrimmedSpaces := &waE2E.Message{
		ImageMessage: &waE2E.ImageMessage{
			Mimetype: proto.String("image/jpeg"),
			Caption:  proto.String("   "),
		},
	}
	if got := messageText(imageCaptionTrimmedSpaces); got != "📷 Photo" {
		t.Fatalf("messageText(image whitespace caption) = %q", got)
	}

	videoWithCaption := &waE2E.Message{
		VideoMessage: &waE2E.VideoMessage{
			Mimetype: proto.String("video/mp4"),
			Caption:  proto.String("Walkthrough 3BHK Bandra 95L"),
		},
	}
	if got := messageText(videoWithCaption); got != "Walkthrough 3BHK Bandra 95L" {
		t.Fatalf("messageText(video + caption) = %q", got)
	}

	videoWithoutCaption := &waE2E.Message{
		VideoMessage: &waE2E.VideoMessage{Mimetype: proto.String("video/mp4")},
	}
	if got := messageText(videoWithoutCaption); got != "🎥 Video" {
		t.Fatalf("messageText(video no caption) = %q", got)
	}

	docWithCaption := &waE2E.Message{
		DocumentMessage: &waE2E.DocumentMessage{
			Mimetype: proto.String("application/pdf"),
			FileName: proto.String("inventory.pdf"),
			Caption:  proto.String("Full inventory — 4 flats available"),
		},
	}
	if got := messageText(docWithCaption); got != "Full inventory — 4 flats available" {
		t.Fatalf("messageText(doc + caption) = %q", got)
	}

	docWithoutCaption := &waE2E.Message{
		DocumentMessage: &waE2E.DocumentMessage{
			Mimetype: proto.String("application/pdf"),
			FileName: proto.String("inventory.pdf"),
		},
	}
	if got := messageText(docWithoutCaption); got != "📄 inventory.pdf" {
		t.Fatalf("messageText(doc no caption) = %q", got)
	}
}
