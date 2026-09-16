package main

import (
	"encoding/json"
	"testing"
)

func TestMessagePayloadMapDecodesRawMessage(t *testing.T) {
	raw := json.RawMessage(`{"extendedTextMessage":{"text":"3 BHK in Bandra West"}}`)
	payload := messagePayloadMap(raw)
	if got := extractMessageText(payload); got != "3 BHK in Bandra West" {
		t.Fatalf("extractMessageText() = %q", got)
	}
}

func TestMessagePayloadMapDecodesJSONBytes(t *testing.T) {
	payload := messagePayloadMap([]byte(`{"conversation":"actual group message"}`))
	if got := extractMessageText(payload); got != "actual group message" {
		t.Fatalf("extractMessageText() = %q", got)
	}
}

func TestMessagePayloadMapRejectsInvalidPayload(t *testing.T) {
	if got := messagePayloadMap("not-json"); got != nil {
		t.Fatalf("messagePayloadMap() = %#v, want nil", got)
	}
}

func TestJSONDocumentBindsTextRatherThanBinaryBytes(t *testing.T) {
	if got := jsonDocument(json.RawMessage(`{"key":"value"}`), "{}"); got != `{"key":"value"}` {
		t.Fatalf("jsonDocument() = %q", got)
	}
	if got := jsonDocument([]byte("not json"), "[]"); got != "[]" {
		t.Fatalf("jsonDocument() fallback = %q", got)
	}
}
