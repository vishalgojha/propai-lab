package main

import (
	"errors"
	"sync"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

const testDMConsentVersion = "broker-dm-capture-test"

// useTestDMConsentVersion points the DM gate at a fixed consent version and
// restores the environment afterwards.
func useTestDMConsentVersion(t *testing.T) {
	t.Helper()
	t.Setenv("PROPAI_DM_CAPTURE_CONSENT_VERSION", testDMConsentVersion)
	dmConsentVersionOnce = sync.Once{}
	dmConsentVersion = ""
	t.Cleanup(func() {
		dmConsentVersionOnce = sync.Once{}
		dmConsentVersion = ""
	})
}

const testListingText = "2 BHK available for rent in Bandra West, 85k per month, 950 sqft carpet, immediate possession"
const testPersonalText = "haan bhai kal milte hain, thanks for the update, talk soon"

func dmTestPayload(remoteJID string) map[string]interface{} {
	return map[string]interface{}{
		"event": "MESSAGES_UPSERT",
		"data": map[string]interface{}{
			"key": map[string]interface{}{
				"remoteJid": remoteJID,
				"id":        "MSG-DM-CAPTURE-GATE",
				"fromMe":    false,
			},
			"pushName":         "Ravi Broker",
			"message":          map[string]interface{}{"conversation": testListingText},
			"message_type":     "conversation",
			"messageTimestamp": float64(1764000000),
		},
	}
}

func expectDMGateQuery(mock sqlmock.Sqlmock, brokerID, senderPhone string, allowed bool) {
	mock.ExpectQuery("broker_dm_capture_senders").
		WithArgs(brokerID, senderPhone, testDMConsentVersion).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(allowed))
}

func TestDMGateQueryRequiresDesignatedActiveRow(t *testing.T) {
	useTestDMConsentVersion(t)
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}

	mock.ExpectQuery("s.version = ").
		WithArgs("broker-dm-shape", "919812345678", testDMConsentVersion).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))

	if !sm.brokerDMCaptureAllowed("broker-dm-shape", "919812345678") {
		t.Fatal("designated sender with current consent version must pass")
	}
	// Second call must come from cache.
	if !sm.brokerDMCaptureAllowed("broker-dm-shape", "919812345678") {
		t.Fatal("cached allow decision must be reused")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestDMGateDeniedForUndesignatedSender(t *testing.T) {
	useTestDMConsentVersion(t)
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}

	expectDMGateQuery(mock, "broker-dm-deny", "919800000001", false)

	if sm.brokerDMCaptureAllowed("broker-dm-deny", "919800000001") {
		t.Fatal("sender without an active designation must not be capturable")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestDMGateDeniedAfterRevocation(t *testing.T) {
	// The revoke trigger and deselect set revoked_at, so the EXISTS is false.
	useTestDMConsentVersion(t)
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}

	expectDMGateQuery(mock, "broker-dm-revoked", "919800000002", false)

	if sm.brokerDMCaptureAllowed("broker-dm-revoked", "919800000002") {
		t.Fatal("revoked designation must stop capture")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestDMGateFailsClosedOnLookupError(t *testing.T) {
	useTestDMConsentVersion(t)
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}

	mock.ExpectQuery("broker_dm_capture_senders").
		WithArgs("broker-dm-err", "919800000003", testDMConsentVersion).
		WillReturnError(errors.New("connection reset"))

	if sm.brokerDMCaptureAllowed("broker-dm-err", "919800000003") {
		t.Fatal("permission lookup errors must fail closed")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestDMGateDeniedWithNilDB(t *testing.T) {
	useTestDMConsentVersion(t)
	sm := &SessionManager{}
	if sm.brokerDMCaptureAllowed("broker-dm-nildb", "919800000004") {
		t.Fatal("missing database must fail closed")
	}
}

func TestDMGateUsesDefaultConsentVersionWithoutEnv(t *testing.T) {
	t.Setenv("PROPAI_DM_CAPTURE_CONSENT_VERSION", "")
	dmConsentVersionOnce = sync.Once{}
	dmConsentVersion = ""
	t.Cleanup(func() {
		dmConsentVersionOnce = sync.Once{}
		dmConsentVersion = ""
	})
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}
	mock.ExpectQuery("broker_dm_capture_senders").
		WithArgs("broker-dm-default", "919800000005", defaultDMCaptureConsentVersion).
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
	if sm.brokerDMCaptureAllowed("broker-dm-default", "919800000005") {
		t.Fatal("a designation without the consent version must not pass the gate")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestInsertRawMessagePersistsDesignatedSenderListing(t *testing.T) {
	useTestDMConsentVersion(t)
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}

	expectTenantLookup(mock, "broker-dm-persist")
	expectDMGateQuery(mock, "broker-dm-persist", "919812345678", true)
	mock.ExpectQuery("INSERT INTO public.raw_messages").
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(77))

	rawID, duplicate, err := sm.insertRawMessage("broker-dm-persist", dmTestPayload("919812345678@s.whatsapp.net"))
	if err != nil {
		t.Fatalf("designated sender's listing must persist: %v", err)
	}
	if rawID != 77 || duplicate {
		t.Fatalf("designated sender returned rawID=%d duplicate=%v, want 77/false", rawID, duplicate)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestInsertRawMessageSkipsUndesignatedSender(t *testing.T) {
	useTestDMConsentVersion(t)
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}

	expectTenantLookup(mock, "broker-dm-skip")
	expectDMGateQuery(mock, "broker-dm-skip", "919812345679", false)
	// No INSERT expectation: any write to raw_messages fails this test.

	rawID, duplicate, err := sm.insertRawMessage("broker-dm-skip", dmTestPayload("919812345679@s.whatsapp.net"))
	if err != nil {
		t.Fatalf("undesignated sender must be skipped, not errored: %v", err)
	}
	if rawID != 0 || duplicate {
		t.Fatalf("undesignated sender returned rawID=%d duplicate=%v, want 0/false", rawID, duplicate)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestInsertRawMessageSkipsPersonalMessageFromDesignatedSender(t *testing.T) {
	useTestDMConsentVersion(t)
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}

	expectTenantLookup(mock, "broker-dm-content")
	expectDMGateQuery(mock, "broker-dm-content", "919812345680", true)
	// No INSERT expectation: the content gate must drop personal chatter even
	// from a designated sender.
	payload := dmTestPayload("919812345680@s.whatsapp.net")
	payload["data"].(map[string]interface{})["message"] = map[string]interface{}{"conversation": testPersonalText}

	rawID, duplicate, err := sm.insertRawMessage("broker-dm-content", payload)
	if err != nil {
		t.Fatalf("non-listing message must be skipped, not errored: %v", err)
	}
	if rawID != 0 || duplicate {
		t.Fatalf("non-listing message returned rawID=%d duplicate=%v, want 0/false", rawID, duplicate)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestInsertRawMessageSkipsOwnOutgoingDM(t *testing.T) {
	useTestDMConsentVersion(t)
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}

	expectTenantLookup(mock, "broker-dm-fromme")
	// No gate query and no INSERT: fromMe messages are dropped before any
	// permission check, so the owner's own replies are never captured.
	payload := dmTestPayload("919812345681@s.whatsapp.net")
	payload["data"].(map[string]interface{})["key"].(map[string]interface{})["fromMe"] = true

	rawID, duplicate, err := sm.insertRawMessage("broker-dm-fromme", payload)
	if err != nil {
		t.Fatalf("own outgoing DM must be skipped, not errored: %v", err)
	}
	if rawID != 0 || duplicate {
		t.Fatalf("own outgoing DM returned rawID=%d duplicate=%v, want 0/false", rawID, duplicate)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestInsertRawMessageRejectsBroadcastAndNewsletterJIDs(t *testing.T) {
	useTestDMConsentVersion(t)
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}

	expectTenantLookup(mock, "broker-dm-broadcast")
	if _, _, err := sm.insertRawMessage("broker-dm-broadcast", dmTestPayload("12345@broadcast")); err == nil {
		t.Fatal("@broadcast JIDs must stay rejected")
	}
	expectTenantLookup(mock, "broker-dm-newsletter")
	if _, _, err := sm.insertRawMessage("broker-dm-newsletter", dmTestPayload("12345@newsletter")); err == nil {
		t.Fatal("@newsletter JIDs must stay rejected")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestInsertRawMessageResolvesLIDSenderThroughPhoneMap(t *testing.T) {
	useTestDMConsentVersion(t)
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}

	expectTenantLookup(mock, "broker-dm-lid")
	// The @lid JID is bridged to a phone before the gate check.
	mock.ExpectQuery("whatsmeow_lid_map").
		WithArgs("100200300400").
		WillReturnRows(sqlmock.NewRows([]string{"pn"}).AddRow("919812345682"))
	expectDMGateQuery(mock, "broker-dm-lid", "919812345682", true)
	mock.ExpectQuery("INSERT INTO public.raw_messages").
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(78))

	rawID, _, err := sm.insertRawMessage("broker-dm-lid", dmTestPayload("100200300400@lid"))
	if err != nil {
		t.Fatalf("LID sender mapped to a designated phone must persist: %v", err)
	}
	if rawID != 78 {
		t.Fatalf("LID sender returned rawID=%d, want 78", rawID)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestLooksLikePropertyListing(t *testing.T) {
	cases := []struct {
		name string
		text string
		want bool
	}{
		{"bhk+price+rent", "2 BHK for rent in Andheri West, 75k per month, semi furnished, call now", true},
		{"bhk+sale+cr", "3 BHK for sale in Powai, 2.4 cr, garden facing, immediate possession available", true},
		{"size+lease", "Office space 1200 sqft available for lease in BKC, prime location, call broker", true},
		{"price+availability", "Flat available in Juhu, 1.5 crore, sea facing, ready to move, serious buyers", true},
		// Requirement posts (the other half of broadcast inventory): a seeker,
		// not an offer. Each carries at least two independent signals.
		{"requirement+bhk+budget", "Requirement: 2 BHK in Bandra West, budget 90k per month, family, immediate move", true},
		{"looking+lease+lac", "Looking for 3 BHK on lease in Powai, budget 1.5 lac, ready possession", true},
		{"need+size+budget", "Need office space 800 sqft in BKC, budget 2 lakh, ready to move in", true},
		{"hinglish requirement", "2bhk chahiye Bandra mein, rent 80k tak, family hai, jaldi chahiye", true},
		{"requirement without price or size stays out", "Requirement for a flat in Bandra West for a small family moving next month", false},
		{"personal greeting", "Good morning sir, hope you are doing well, let's catch up soon", false},
		{"single signal only", "This 2 BHK is the one I was telling you about yesterday evening", false},
		{"looking alone is one signal", "Looking for a good place to eat dinner tonight around Bandra side, any suggestions", false},
		{"too short", "2 BHK 75k rent", false},
		{"empty", "", false},
		{"generic chat with number", "call me at 98200 12345 when you are free this weekend, no rush", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := looksLikePropertyListing(tc.text); got != tc.want {
				t.Fatalf("looksLikePropertyListing(%q) = %v, want %v", tc.text, got, tc.want)
			}
		})
	}
}

func TestNormalizeDMPhone(t *testing.T) {
	cases := []struct {
		in   string
		want string
	}{
		{"919812345678@s.whatsapp.net", "919812345678"},
		{"919812345678:12@s.whatsapp.net", "919812345678"},
		{"919812345678.0:12@s.whatsapp.net", "919812345678"},
		{"919812345678", "919812345678"},
		{"+91 98123 45678", "919812345678"},
		{"", ""},
		{"12345", ""},
		{"1234567890123456", ""},
		{"abc@lid", ""},
	}
	for _, tc := range cases {
		if got := normalizeDMPhone(tc.in); got != tc.want {
			t.Fatalf("normalizeDMPhone(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
