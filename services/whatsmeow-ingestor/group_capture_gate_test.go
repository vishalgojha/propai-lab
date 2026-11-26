package main

import (
	"errors"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

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

func TestGroupCaptureAllowedForSelectedGroup(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}

	mock.ExpectQuery("organization_group_connections").
		WithArgs("broker-gate-allow", "111@g.us").
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))

	if !sm.groupCaptureAllowed("broker-gate-allow", "111@g.us") {
		t.Fatal("selected group must be capturable")
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

func TestGroupCaptureDeniedForUnselectedGroup(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}

	mock.ExpectQuery("organization_group_connections").
		WithArgs("broker-gate-deny", "222@g.us").
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))

	if sm.groupCaptureAllowed("broker-gate-deny", "222@g.us") {
		t.Fatal("unselected group must not be capturable")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestGroupCaptureFailsClosedOnLookupError(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}

	mock.ExpectQuery("organization_group_connections").
		WithArgs("broker-gate-err", "333@g.us").
		WillReturnError(errors.New("connection reset"))

	if sm.groupCaptureAllowed("broker-gate-err", "333@g.us") {
		t.Fatal("permission lookup errors must fail closed")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestGroupCaptureDeniedWithNilDB(t *testing.T) {
	sm := &SessionManager{}
	if sm.groupCaptureAllowed("broker-gate-nildb", "444@g.us") {
		t.Fatal("missing database must fail closed")
	}
}

func TestInsertRawMessageSkipsUnselectedGroup(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}

	mock.ExpectQuery("org_whatsapp_connections").
		WithArgs("broker-gate-skip").
		WillReturnRows(sqlmock.NewRows([]string{"organization_id"}).AddRow("org-1"))
	mock.ExpectQuery("organization_group_connections").
		WithArgs("broker-gate-skip", "555@g.us").
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(false))
	// No INSERT expectation: any write to raw_messages fails this test.

	rawID, duplicate, err := sm.insertRawMessage("broker-gate-skip", captureTestPayload("555@g.us"))
	if err != nil {
		t.Fatalf("unselected group must be skipped, not errored: %v", err)
	}
	if rawID != 0 || duplicate {
		t.Fatalf("unselected group returned rawID=%d duplicate=%v, want 0/false", rawID, duplicate)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestInsertRawMessagePersistsSelectedGroup(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}

	mock.ExpectQuery("org_whatsapp_connections").
		WithArgs("broker-gate-persist").
		WillReturnRows(sqlmock.NewRows([]string{"organization_id"}).AddRow("org-1"))
	mock.ExpectQuery("organization_group_connections").
		WithArgs("broker-gate-persist", "666@g.us").
		WillReturnRows(sqlmock.NewRows([]string{"exists"}).AddRow(true))
	mock.ExpectQuery("INSERT INTO public.raw_messages").
		WillReturnRows(sqlmock.NewRows([]string{"id"}).AddRow(42))

	rawID, duplicate, err := sm.insertRawMessage("broker-gate-persist", captureTestPayload("666@g.us"))
	if err != nil {
		t.Fatalf("selected group must persist: %v", err)
	}
	if rawID != 42 || duplicate {
		t.Fatalf("selected group returned rawID=%d duplicate=%v, want 42/false", rawID, duplicate)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestInsertRawMessageStillRejectsDirectMessages(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	sm := &SessionManager{db: db}

	mock.ExpectQuery("org_whatsapp_connections").
		WithArgs("broker-gate-dm").
		WillReturnRows(sqlmock.NewRows([]string{"organization_id"}).AddRow("org-1"))
	// DMs must be rejected before any permission check or insert.

	if _, _, err := sm.insertRawMessage("broker-gate-dm", captureTestPayload("919999999999@s.whatsapp.net")); err == nil {
		t.Fatal("direct-message ingestion must stay disabled")
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
