package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

const (
	deviceJIDLookupSQL = "SELECT device_jid FROM broker_whatsapp_devices WHERE whatsapp_connection_key=$1"
	deviceDeleteSQL    = "DELETE FROM broker_whatsapp_devices WHERE whatsapp_connection_key=$1"
)

func newDeleteSessionMockSM(t *testing.T) (*SessionManager, sqlmock.Sqlmock) {
	t.Helper()
	db, mock, err := sqlmock.New(sqlmock.QueryMatcherOption(sqlmock.QueryMatcherEqual))
	if err != nil {
		t.Fatalf("sqlmock.New: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	return &SessionManager{sessions: map[string]*BrokerSession{}, db: db}, mock
}

func postDeleteSession(sm *SessionManager, brokerID string) *httptest.ResponseRecorder {
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/delete-session?broker_id="+brokerID, nil)
	sm.deleteSessionHandler(recorder, request)
	return recorder
}

func decodeBody(t *testing.T, recorder *httptest.ResponseRecorder) map[string]interface{} {
	t.Helper()
	var body map[string]interface{}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("response is not a JSON object: %v (%q)", err, recorder.Body.String())
	}
	return body
}

// The API's delete_phone refuses to remove the workspace phone unless the
// ingestor receipt carries credentials_deleted, mapping_deleted and reset_at.
// A bare {"ok": true} made every Remove report 502 after the session had
// actually been deleted (owner incident, Nov 25 18:43 IST).
func TestDeleteSessionInactiveBrokerReturnsContractReceipt(t *testing.T) {
	sm, mock := newDeleteSessionMockSM(t)
	mock.ExpectQuery(deviceJIDLookupSQL).WithArgs("phone-x").
		WillReturnRows(sqlmock.NewRows([]string{"device_jid"}))
	mock.ExpectQuery(deviceJIDLookupSQL).WithArgs("phone-x").
		WillReturnRows(sqlmock.NewRows([]string{"device_jid"}))
	mock.ExpectExec(deviceDeleteSQL).WithArgs("phone-x").
		WillReturnResult(sqlmock.NewResult(0, 0))

	recorder := postDeleteSession(sm, "phone-x")
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	body := decodeBody(t, recorder)
	if body["ok"] != true || body["credentials_deleted"] != true || body["mapping_deleted"] != true {
		t.Fatalf("receipt missing contract fields: %v", body)
	}
	if resetAt, _ := body["reset_at"].(string); resetAt == "" {
		t.Fatalf("receipt missing reset_at: %v", body)
	}
	if body["broker_id"] != "phone-x" {
		t.Fatalf("receipt broker_id mismatch: %v", body)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet db expectations: %v", err)
	}
}

// A repeat Remove after a successful one finds no session and no mapping; it
// must still return the full receipt so the API can proceed to remove the
// workspace phone.
func TestDeleteSessionRepeatRemainsSuccessful(t *testing.T) {
	sm, mock := newDeleteSessionMockSM(t)
	for i := 0; i < 2; i++ {
		mock.ExpectQuery(deviceJIDLookupSQL).WithArgs("phone-x").
			WillReturnRows(sqlmock.NewRows([]string{"device_jid"}))
		mock.ExpectQuery(deviceJIDLookupSQL).WithArgs("phone-x").
			WillReturnRows(sqlmock.NewRows([]string{"device_jid"}))
		mock.ExpectExec(deviceDeleteSQL).WithArgs("phone-x").
			WillReturnResult(sqlmock.NewResult(0, 0))
	}

	for i := 0; i < 2; i++ {
		recorder := postDeleteSession(sm, "phone-x")
		if recorder.Code != http.StatusOK {
			t.Fatalf("attempt %d: expected 200, got %d: %s", i+1, recorder.Code, recorder.Body.String())
		}
		body := decodeBody(t, recorder)
		if body["credentials_deleted"] != true || body["mapping_deleted"] != true {
			t.Fatalf("attempt %d: receipt missing contract fields: %v", i+1, body)
		}
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet db expectations: %v", err)
	}
}

func TestDeleteSessionMappingDeleteFailureReturns500(t *testing.T) {
	sm, mock := newDeleteSessionMockSM(t)
	mock.ExpectQuery(deviceJIDLookupSQL).WithArgs("phone-x").
		WillReturnRows(sqlmock.NewRows([]string{"device_jid"}))
	mock.ExpectQuery(deviceJIDLookupSQL).WithArgs("phone-x").
		WillReturnRows(sqlmock.NewRows([]string{"device_jid"}))
	mock.ExpectExec(deviceDeleteSQL).WithArgs("phone-x").
		WillReturnError(errors.New("db down"))

	recorder := postDeleteSession(sm, "phone-x")
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d: %s", recorder.Code, recorder.Body.String())
	}
	body := decodeBody(t, recorder)
	if _, ok := body["error"].(string); !ok {
		t.Fatalf("expected error body, got %v", body)
	}
	if _, leaked := body["credentials_deleted"]; leaked {
		t.Fatalf("failure response must not carry a receipt: %v", body)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet db expectations: %v", err)
	}
}

func TestDeleteSessionLookupFailureReturns500(t *testing.T) {
	sm, mock := newDeleteSessionMockSM(t)
	mock.ExpectQuery(deviceJIDLookupSQL).WithArgs("phone-x").
		WillReturnError(errors.New("db down"))

	recorder := postDeleteSession(sm, "phone-x")
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("expected 500, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatalf("unmet db expectations: %v", err)
	}
}

// When the live session does not confirm shutdown, the handler must report a
// conflict and leave credentials untouched instead of issuing a receipt.
func TestDeleteSessionStopUnconfirmedConflict(t *testing.T) {
	session := &BrokerSession{brokerID: "phone-x", cancel: func() {}}
	sm := &SessionManager{sessions: map[string]*BrokerSession{"phone-x": session}}

	recorder := postDeleteSession(sm, "phone-x")
	if recorder.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", recorder.Code, recorder.Body.String())
	}
	body := decodeBody(t, recorder)
	if _, leaked := body["credentials_deleted"]; leaked {
		t.Fatalf("conflict response must not carry a receipt: %v", body)
	}
}
