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
	"time"
)

const webhookOutboxDDL = `CREATE TABLE IF NOT EXISTS whatsapp_webhook_outbox (
	id BIGSERIAL PRIMARY KEY,
	broker_id TEXT NOT NULL,
	event_id TEXT NOT NULL UNIQUE,
	payload JSONB NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0,
	next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	last_error TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`

var webhookHTTPClient = &http.Client{Timeout: 15 * time.Second}

func (sm *SessionManager) queueWebhook(brokerID, eventID string, payload map[string]interface{}) bool {
	encoded, err := json.Marshal(payload)
	if err != nil {
		log.Printf("[broker %s] webhook marshal failed: %v", brokerID, err)
		return false
	}
	if eventID == "" {
		eventID = fmt.Sprintf("%s:%d", brokerID, time.Now().UnixNano())
	}
	_, err = sm.db.ExecContext(context.Background(), `
		INSERT INTO whatsapp_webhook_outbox (broker_id, event_id, payload)
		VALUES ($1, $2, $3::jsonb)
		ON CONFLICT (event_id) DO NOTHING`, brokerID, eventID, encoded)
	if err != nil {
		log.Printf("[broker %s] webhook enqueue failed: %v", brokerID, err)
		return false
	}
	go sm.flushWebhookOutbox()
	return true
}

func (sm *SessionManager) startWebhookDispatcher(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				sm.flushWebhookOutbox()
			case <-ctx.Done():
				return
			}
		}
	}()
}

func (sm *SessionManager) flushWebhookOutbox() {
	sm.deliveryMu.Lock()
	defer sm.deliveryMu.Unlock()

	rows, err := sm.db.QueryContext(context.Background(), `
		SELECT id, broker_id, payload, attempts
		FROM whatsapp_webhook_outbox
		WHERE next_attempt_at <= NOW()
		ORDER BY id
		LIMIT 50`)
	if err != nil {
		log.Printf("webhook outbox query failed: %v", err)
		return
	}
	defer rows.Close()

	type queuedEvent struct {
		id       int64
		brokerID string
		payload  []byte
		attempts int
	}
	queued := make([]queuedEvent, 0, 50)
	for rows.Next() {
		var item queuedEvent
		if err := rows.Scan(&item.id, &item.brokerID, &item.payload, &item.attempts); err != nil {
			log.Printf("webhook outbox scan failed: %v", err)
			continue
		}
		queued = append(queued, item)
	}

	for _, item := range queued {
		err := postWebhookPayload(item.payload)
		if err == nil {
			if _, deleteErr := sm.db.ExecContext(context.Background(),
				"DELETE FROM whatsapp_webhook_outbox WHERE id=$1", item.id); deleteErr != nil {
				log.Printf("[broker %s] webhook outbox delete failed: %v", item.brokerID, deleteErr)
			}
			continue
		}
		attempts := item.attempts + 1
		delaySeconds := 1 << min(attempts, 8)
		_, updateErr := sm.db.ExecContext(context.Background(), `
			UPDATE whatsapp_webhook_outbox
			SET attempts=$2,
				next_attempt_at=NOW() + ($3 * INTERVAL '1 second'),
				last_error=$4
			WHERE id=$1`, item.id, attempts, delaySeconds, err.Error())
		if updateErr != nil {
			log.Printf("[broker %s] webhook outbox retry update failed: %v", item.brokerID, updateErr)
		} else {
			log.Printf("[broker %s] webhook delivery failed (attempt %d): %v", item.brokerID, attempts, err)
		}
	}
}

func postWebhookPayload(payload []byte) error {
	req, err := http.NewRequestWithContext(context.Background(), http.MethodPost, webhookURL, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := webhookHTTPClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("webhook returned %d: %s", resp.StatusCode, string(body))
	}
	return nil
}

func ensureWebhookOutbox(db *sql.DB) error {
	_, err := db.Exec(webhookOutboxDDL)
	return err
}
