package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"
)

var httpClient = &http.Client{Timeout: 10 * time.Second}

// tenantCache maps broker_id → organization_id (resolved once per session).
type tenantCache struct {
	mu    sync.RWMutex
	cache map[string]string
}

var tenants = &tenantCache{cache: make(map[string]string)}
var lidPhoneCache sync.Map

func (tc *tenantCache) get(brokerID string) (string, bool) {
	tc.mu.RLock()
	defer tc.mu.RUnlock()
	id, ok := tc.cache[brokerID]
	return id, ok
}

func (tc *tenantCache) set(brokerID, tenantID string) {
	tc.mu.Lock()
	defer tc.mu.Unlock()
	tc.cache[brokerID] = tenantID
}

// resolveTenantID queries org_whatsapp_connections for the organization_id
// associated with a broker_id.  Result is cached after first lookup.
func resolveTenantID(db *sql.DB, brokerID string) (string, error) {
	if tid, ok := tenants.get(brokerID); ok {
		return tid, nil
	}
	var orgID string
	err := db.QueryRowContext(context.Background(),
		`SELECT organization_id FROM org_whatsapp_connections WHERE broker_id = $1 LIMIT 1`,
		brokerID).Scan(&orgID)
	if err != nil {
		return "", fmt.Errorf("tenant lookup for broker %s: %w", brokerID, err)
	}
	tenants.set(brokerID, orgID)
	return orgID, nil
}

// resolveLIDPhone bridges WhatsApp's hidden-user JID to the phone number
// captured by WhatsMeow. The webhook payload keeps the original @lid JID, but
// whatsmeow_lid_map stores the lid without its suffix.
func resolveLIDPhone(db *sql.DB, senderJID string) string {
	lid := strings.TrimSpace(senderJID)
	if !strings.HasSuffix(lid, "@lid") {
		return ""
	}
	lid = strings.TrimSuffix(lid, "@lid")
	if lid == "" {
		return ""
	}
	if cached, ok := lidPhoneCache.Load(lid); ok {
		return cached.(string)
	}
	var pn string
	if err := db.QueryRowContext(context.Background(),
		`SELECT pn FROM whatsmeow_lid_map WHERE lid = $1 LIMIT 1`, lid,
	).Scan(&pn); err != nil {
		return ""
	}
	pn = strings.TrimSpace(pn)
	if pn == "" {
		return ""
	}
	if !strings.Contains(pn, "@") {
		pn += "@s.whatsapp.net"
	}
	lidPhoneCache.Store(lid, pn)
	return pn
}

// insertRawMessage writes a WhatsApp message directly into raw_messages.
// The extraction worker polls raw_messages WHERE processed=false and handles
// the full extraction pipeline.
//
// Returns the inserted row ID.
func (sm *SessionManager) insertRawMessage(brokerID string, payload map[string]interface{}) (int64, error) {
	tenantID, err := resolveTenantID(sm.db, brokerID)
	if err != nil {
		log.Printf("[broker %s] tenant resolve failed: %v — message will lack tenant_id", brokerID, err)
	}

	data, _ := payload["data"].(map[string]interface{})
	if data == nil {
		data = payload
	}

	key, _ := data["key"].(map[string]interface{})
	senderData, _ := data["sender"].(map[string]interface{})
	msg := messagePayloadMap(data["message"])

	groupJID := ""
	if v, ok := key["remoteJid"].(string); ok {
		groupJID = v
	}
	if groupJID == "" {
		if v, ok := data["from"].(string); ok {
			groupJID = v
		}
	}

	senderJID := ""
	if v, ok := key["participant"].(string); ok && v != "" {
		senderJID = v
	} else if v, ok := senderData["id"].(string); ok {
		senderJID = v
	}

	senderName := ""
	if v, ok := senderData["name"].(string); ok {
		senderName = v
	}
	if senderName == "" {
		if v, ok := data["pushName"].(string); ok {
			senderName = v
		}
	}

	senderPhone := ""
	if v, ok := senderData["phone"].(string); ok {
		senderPhone = v
	}
	if senderPhone == "" {
		senderPhone = resolveLIDPhone(sm.db, senderJID)
	}

	msgText := extractMessageText(msg)
	msgType := extractMessageType(nil)
	if mt, ok := data["message_type"].(string); ok && mt != "" {
		msgType = mt
	}

	isGroup := strings.HasSuffix(groupJID, "@g.us")
	groupName := ""
	if isGroup {
		groupName = groupJID
	}

	var ts interface{} = time.Now().UTC().Format(time.RFC3339)
	if mt, ok := data["messageTimestamp"]; ok {
		// WhatsApp messageTimestamp is Unix seconds - convert to RFC3339 time string
		switch v := mt.(type) {
		case float64:
			ts = time.Unix(int64(v), 0).UTC().Format(time.RFC3339)
		case json.Number:
			if i, err := v.Int64(); err == nil {
				ts = time.Unix(i, 0).UTC().Format(time.RFC3339)
			}
		case int64:
			ts = time.Unix(v, 0).UTC().Format(time.RFC3339)
		case int:
			ts = time.Unix(int64(v), 0).UTC().Format(time.RFC3339)
		case string:
			if t, err := time.Parse(time.RFC3339, v); err == nil {
				ts = t.UTC().Format(time.RFC3339)
			}
		}
	}

	rawPayload, _ := json.Marshal(payload)
	attachments := buildAttachments(msg, data)
	replyCtx := buildReplyContext(msg)
	messageUID := fmt.Sprintf("%s:%s:%s", brokerID, groupJID, key["id"])

	eventID := fmt.Sprintf("%s:%s", brokerID, key["id"])

	var rawID int64
	if tenantID != "" {
		err = sm.db.QueryRowContext(context.Background(), `
			INSERT INTO raw_messages (
				tenant_id, group_name, sender, sender_jid, sender_phone,
				message, message_type, is_group, timestamp, source,
				raw_payload, message_uid, event_id, attachments, reply_context,
				processed, pipeline_version, synced_at
			) VALUES (
				$1, $2, $3, $4, $5,
				$6, $7, $8, $9, 'WHATSAPP',
				$10::jsonb, $11, $12, $13::jsonb, $14::jsonb,
				false, 'go-ingestor', NOW()
			)
			ON CONFLICT (message_uid) DO NOTHING
			RETURNING id`,
			tenantID, groupName, senderName, senderJID, senderPhone,
			msgText, msgType, isGroup, ts,
			rawPayload, messageUID, eventID, attachments, replyCtx,
		).Scan(&rawID)
	} else {
		err = sm.db.QueryRowContext(context.Background(), `
			INSERT INTO raw_messages (
				group_name, sender, sender_jid, sender_phone,
				message, message_type, is_group, timestamp, source,
				raw_payload, message_uid, event_id, attachments, reply_context,
				processed, pipeline_version, synced_at
			) VALUES (
				$1, $2, $3, $4,
				$5, $6, $7, $8, 'WHATSAPP',
				$9::jsonb, $10, $11, $12::jsonb, $13::jsonb,
				false, 'go-ingestor', NOW()
			)
			ON CONFLICT (message_uid) DO NOTHING
			RETURNING id`,
			groupName, senderName, senderJID, senderPhone,
			msgText, msgType, isGroup, ts,
			rawPayload, messageUID, eventID, attachments, replyCtx,
		).Scan(&rawID)
	}
	if err != nil {
		// ON CONFLICT DO NOTHING + RETURNING id yields no rows for duplicates.
		// Fall back to a SELECT so we return the existing row's ID instead of
		// treating the duplicate as a hard failure.
		if err == sql.ErrNoRows {
			_ = sm.db.QueryRowContext(context.Background(),
				`SELECT id FROM raw_messages WHERE message_uid = $1`, messageUID,
			).Scan(&rawID)
			if rawID > 0 {
				return rawID, nil
			}
		}
		return 0, fmt.Errorf("raw_messages insert: %w", err)
	}
	return rawID, nil
}

// fireWebhook delivers a non-message event directly to the API via HTTP POST.
// No outbox, no retry — these events are low-volume and informational.
func fireWebhook(payload map[string]interface{}) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, webhookURL, bytes.NewReader(encoded))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		log.Printf("webhook POST failed: %v", err)
		return
	}
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		log.Printf("webhook returned %d: %s", resp.StatusCode, string(body))
	}
	resp.Body.Close()
}

// triggerExtraction POSTs to /trigger-extraction so the Python API immediately
// schedules extraction for the given raw_message.  This is async and
// non-blocking — the message is already persisted; failure here just means
// extraction waits for the polling worker.
func triggerExtraction(rawID int64, tenantID string) {
	if rawID <= 0 {
		return
	}
	payload := map[string]interface{}{
		"raw_id": rawID,
	}
	if tenantID != "" {
		payload["tenant_id"] = tenantID
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := extractionTriggerURL
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(encoded))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := httpClient.Do(req)
	if err != nil {
		log.Printf("[trigger-extraction] POST failed for raw_id=%d: %v", rawID, err)
		return
	}
	if resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		log.Printf("[trigger-extraction] returned %d for raw_id=%d: %s", resp.StatusCode, rawID, string(body))
	}
	resp.Body.Close()
}

// marshalMessage returns json.RawMessage. Decode that value before extracting
// the body; a direct map assertion silently failed and stored blank text for
// otherwise valid WhatsApp messages.
func messagePayloadMap(value interface{}) map[string]interface{} {
	switch typed := value.(type) {
	case map[string]interface{}:
		return typed
	case json.RawMessage:
		var decoded map[string]interface{}
		if json.Unmarshal(typed, &decoded) == nil {
			return decoded
		}
	case []byte:
		var decoded map[string]interface{}
		if json.Unmarshal(typed, &decoded) == nil {
			return decoded
		}
	case string:
		var decoded map[string]interface{}
		if json.Unmarshal([]byte(typed), &decoded) == nil {
			return decoded
		}
	}
	return nil
}

func extractMessageText(msg map[string]interface{}) string {
	if msg == nil {
		return ""
	}
	if protocol, ok := msg["protocolMessage"].(map[string]interface{}); ok {
		if kind, ok := protocol["type"].(string); ok && strings.EqualFold(kind, "REVOKE") {
			return "Message recalled"
		}
		// Protobuf JSON may encode enum values numerically. The WhatsApp
		// REVOKE enum is 0 in the current whatsmeow schema; the presence of a
		// revoke key is still stronger evidence than a text command.
		if _, ok := protocol["key"]; ok {
			if _, hasEdited := protocol["editedMessage"]; !hasEdited {
				return "Message recalled"
			}
		}
	}
	if v, ok := msg["conversation"].(string); ok && strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v)
	}
	if ext, ok := msg["extendedTextMessage"].(map[string]interface{}); ok {
		if v, ok := ext["text"].(string); ok && strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	for _, kind := range []string{"imageMessage", "videoMessage", "audioMessage", "documentMessage"} {
		if sub, ok := msg[kind].(map[string]interface{}); ok {
			if cap, ok := sub["caption"].(string); ok && cap != "" {
				return cap
			}
		}
	}
	if _, ok := msg["imageMessage"]; ok {
		return "[Image]"
	}
	if _, ok := msg["videoMessage"]; ok {
		return "[Video]"
	}
	if _, ok := msg["audioMessage"]; ok {
		return "[Voice message]"
	}
	if _, ok := msg["documentMessage"]; ok {
		return "[Document]"
	}
	if _, ok := msg["stickerMessage"]; ok {
		return "[Sticker]"
	}
	return ""
}

func buildAttachments(msg map[string]interface{}, data map[string]interface{}) json.RawMessage {
	if msg == nil {
		return json.RawMessage("[]")
	}
	media, _ := data["media"].(map[string]interface{})
	attachments := map[string]interface{}{
		"image":    msg["imageMessage"] != nil,
		"video":    msg["videoMessage"] != nil,
		"audio":    msg["audioMessage"] != nil,
		"document": msg["documentMessage"] != nil,
		"sticker":  msg["stickerMessage"] != nil,
	}
	for _, kind := range []string{"image", "video", "audio", "document", "sticker"} {
		if sub, ok := msg[kind+"Message"].(map[string]interface{}); ok {
			if mime, ok := sub["mimetype"].(string); ok {
				attachments["mime_type"] = mime
			}
			if fn, ok := sub["fileName"].(string); ok {
				attachments["file_name"] = fn
			}
		}
	}
	if media != nil {
		if v, ok := media["storage_path"].(string); ok {
			attachments["storage_path"] = v
		}
		if v, ok := media["file_length"]; ok {
			attachments["file_length"] = v
		}
		if v, ok := media["error"].(string); ok {
			attachments["capture_error"] = v
		}
	}
	b, _ := json.Marshal([]interface{}{attachments})
	return b
}

func buildReplyContext(msg map[string]interface{}) json.RawMessage {
	if msg == nil {
		return json.RawMessage("{}")
	}
	if ext, ok := msg["extendedTextMessage"].(map[string]interface{}); ok {
		if ci, ok := ext["contextInfo"].(map[string]interface{}); ok {
			b, _ := json.Marshal(ci)
			return b
		}
	}
	for _, kind := range []string{"imageMessage", "videoMessage"} {
		if sub, ok := msg[kind].(map[string]interface{}); ok {
			if ci, ok := sub["contextInfo"].(map[string]interface{}); ok {
				b, _ := json.Marshal(ci)
				return b
			}
		}
	}
	return json.RawMessage("{}")
}
