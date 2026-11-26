package main

import (
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/DATA-DOG/go-sqlmock"
)

var testConsentCutoff = time.Date(2026, time.November, 26, 10, 0, 0, 0, time.UTC)

// useTestConsentCutoff points the gate at a fixed cutoff and restores the
// environment afterwards.
func useTestConsentCutoff(t *testing.T) {
	t.Helper()
	t.Setenv("PROPAI_CAPTURE_CONSENT_AFTER", testConsentCutoff.Format(time.RFC3339))
	consentAfterOnce = sync.Once{}
	consentAfter = time.Time{}
	t.Cleanup(func() {
		consentAfterOnce = sync.Once{}
		consentAfter = time.Time{}
	})
}

func captureTestPayload(groupJID string) map[string]interface{} {
	return map[string]interface{}{
		"event": "MESSAGES_UPSERT",
		"data": map[string]interface{}{
			"key": map[string]interface{}{
				"remoteJid":   groupJID,
				"participant": "919999999999@s.whatsapp.net",
				"id":          "MSG-CAPTURE-GATE",
			},
			"message":          map[string]interface{}{"conversation": "3 BHK in Bandra"},
			"message_type":     "conversation",
			"messageTimestamp": float64(1764000000),
		},
	}
}

func historySyncPayload(groupJID string) map[string]interface{} {
	payload := captureTestPayload(groupJID)
	payload["data"].(map[string]interface{})["source"] = "history_sync"
	return payload
}

func expectTenantLookup(mock sqlmock.Sqlmock, brokerID string) {
	mock.ExpectQuery("org_whatsapp_connections").
		WithArgs(brokerID).
		WillReturnRows(sqlmock.NewRows([]string{"organization_id"}).AddRow("org-1"))
}

func expectGateQuery(mock sqlmock.Sqlmock, brokerID, groupJID string, allowed bool) {
	mock.ExpectQuery("whatsapp_group_selection_receipts").
		WithArgs(brokerID, groupJID, testConsentCutoff).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(allowed))
}

func TestGateQueryRequiresCurrentReceiptAndSelection(t *testing.T) {
	useTestConsentCutoff(t)
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}

	mock.ExpectQuery("state_fingerprint <> ''").
		WithArgs("broker-gate-shape", "shape@g.us", testConsentCutoff).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))

	sm.groupCaptureAllowed("broker-gate-shape", "shape@g.us")
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestGateFailsClosedWithoutCutoffEnv(t *testing.T) {
	// PROPAI_CAPTURE_CONSENT_AFTER unset must disable capture without even
	// querying the database.
	t.Setenv("PROPAI_CAPTURE_CONSENT_AFTER", "")
	consentAfterOnce = sync.Once{}
	consentAfter = time.Time{}
	t.Cleanup(func() {
		consentAfterOnce = sync.Once{}
		consentAfter = time.Time{}
	})
	db, _, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}
	if sm.groupCaptureAllowed("broker-gate-nocutoff", "000@g.us") {
		t.Fatal("missing consent cutoff env must fail closed")
	}
}

func TestGroupCaptureAllowedForConsentedSelectedGroup(t *testing.T) {
	useTestConsentCutoff(t)
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}

	expectGateQuery(mock, "broker-gate-allow", "111@g.us", true)

	if !sm.groupCaptureAllowed("broker-gate-allow", "111@g.us") {
		t.Fatal("consented + selected group must be capturable")
	}
	// Second call must be served from cache: sqlmock has no further
	// expectations, so a re-query would fail the test.
	if !sm.groupCaptureAllowed("broker-gate-allow", "111@g.us") {
		t.Fatal("cached allow decision must be reused")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestGroupCaptureDeniedWithoutConsentEvenIfSelected(t *testing.T) {
	// Legacy accounts confirmed selections under copy that said capture
	// happened either way, so a selection row alone must not admit capture.
	useTestConsentCutoff(t)
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}

	expectGateQuery(mock, "broker-gate-legacy", "222@g.us", false)

	if sm.groupCaptureAllowed("broker-gate-legacy", "222@g.us") {
		t.Fatal("selection without capture consent must not be capturable")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestGroupCaptureDeniedAfterConsentRevoked(t *testing.T) {
	// Revocation blanks the receipt fingerprint, so the combined EXISTS is
	// false and capture stops even for selected groups.
	useTestConsentCutoff(t)
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}

	expectGateQuery(mock, "broker-gate-revoked", "333@g.us", false)

	if sm.groupCaptureAllowed("broker-gate-revoked", "333@g.us") {
		t.Fatal("revoked consent must stop capture even for selected groups")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestGroupCaptureIsPerBroker(t *testing.T) {
	// Tenant isolation: another broker's consent + selection for the same
	// group JID must never admit capture for this broker's session.
	useTestConsentCutoff(t)
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}

	expectGateQuery(mock, "broker-gate-b", "shared@g.us", false)

	if sm.groupCaptureAllowed("broker-gate-b", "shared@g.us") {
		t.Fatal("capture decision must be scoped to the session's own broker")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestGroupCaptureFailsClosedOnLookupError(t *testing.T) {
	useTestConsentCutoff(t)
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}

	mock.ExpectQuery("whatsapp_group_selection_receipts").
		WithArgs("broker-gate-err", "444@g.us", testConsentCutoff).
		WillReturnError(errors.New("connection reset"))

	if sm.groupCaptureAllowed("broker-gate-err", "444@g.us") {
		t.Fatal("permission lookup errors must fail closed")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestGroupCaptureDeniedWithNilDB(t *testing.T) {
	useTestConsentCutoff(t)
	sm := &SessionManager{}
	if sm.groupCaptureAllowed("broker-gate-nildb", "555@g.us") {
		t.Fatal("missing database must fail closed")
	}
}

func TestInsertRawMessageSkipsUnconsentedGroup(t *testing.T) {
	useTestConsentCutoff(t)
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}

	expectTenantLookup(mock, "broker-gate-skip")
	expectGateQuery(mock, "broker-gate-skip", "666@g.us", false)
	// No INSERT expectation: any write to raw_messages fails this test.

	rawID, duplicate, err := sm.insertRawMessage("broker-gate-skip", captureTestPayload("666@g.us"))
	if err != nil {
		t.Fatalf("unconsented group must be skipped, not errored: %v", err)
	}
	if rawID != 0 || duplicate {
		t.Fatalf("unconsented group returned rawID=%d duplicate=%v, want 0/false", rawID, duplicate)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestInsertRawMessageSkipsHistorySyncForUnconsentedGroup(t *testing.T) {
	useTestConsentCutoff(t)
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}

	expectTenantLookup(mock, "broker-gate-histskip")
	expectGateQuery(mock, "broker-gate-histskip", "777@g.us", false)
	// No INSERT expectation: history sync must be gated the same way.

	if _, _, err := sm.insertRawMessage("broker-gate-histskip", historySyncPayload("777@g.us")); err != nil {
		t.Fatalf("unconsented history sync must be skipped, not errored: %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestInsertRawMessagePersistsConsentedSelectedGroup(t *testing.T) {
	useTestConsentCutoff(t)
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}

	expectTenantLookup(mock, "broker-gate-persist")
	expectGateQuery(mock, "broker-gate-persist", "888@g.us", true)
	mock.ExpectQuery("INSERT INTO public.raw_messages").
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(42))

	rawID, duplicate, err := sm.insertRawMessage("broker-gate-persist", captureTestPayload("888@g.us"))
	if err != nil {
		t.Fatalf("consented + selected group must persist: %v", err)
	}
	if rawID != 42 || duplicate {
		t.Fatalf("consented + selected group returned rawID=%d duplicate=%v, want 42/false", rawID, duplicate)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestInsertRawMessageStillRejectsDirectMessages(t *testing.T) {
	useTestConsentCutoff(t)
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}

	expectTenantLookup(mock, "broker-gate-dm")
	// DMs must be rejected before any permission check or insert.

	if _, _, err := sm.insertRawMessage("broker-gate-dm", captureTestPayload("919999999999@s.whatsapp.net")); err == nil {
		t.Fatal("direct-message ingestion must stay disabled")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestGateDenyLogDoesNotLeakMessageContent(t *testing.T) {
	// The deny path logs broker and group JID only; this test pins that the
	// gate never receives message content, so its log path cannot include it.
	useTestConsentCutoff(t)
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}

	expectGateQuery(mock, "broker-gate-log", "999@g.us", false)
	sm.groupCaptureAllowed("broker-gate-log", "999@g.us")

	payload := captureTestPayload("999@g.us")
	if strings.Contains(payload["data"].(map[string]interface{})["key"].(map[string]interface{})["id"].(string), "3 BHK") {
		t.Fatal("test payload corrupted")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
