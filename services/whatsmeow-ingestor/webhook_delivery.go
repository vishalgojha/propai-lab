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
	"sync"
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

type queuedWebhookEvent struct {
	id       int64
	brokerID string
	payload  []byte
	attempts int
}

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
	select {
	case sm.deliveryWake <- struct{}{}:
	default:
	}
	return true
}

func (sm *SessionManager) startWebhookDispatcher(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()
		sm.flushWebhookOutbox()
		for {
			select {
			case <-ticker.C:
				sm.flushWebhookOutbox()
			case <-sm.deliveryWake:
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

	// Keep claims deliberately small. A large backlog must not make one
	// transaction hold 100 queue rows while the next batch is being chosen.
	batchSize := getEnvInt("WEBHOOK_DELIVERY_BATCH_SIZE", 25)
	if batchSize < 1 {
		batchSize = 25
	}
	if batchSize > 100 {
		batchSize = 100
	}
	queued, err := sm.claimWebhookOutbox(batchSize)
	if err != nil {
		log.Printf("webhook outbox claim failed: %v", err)
		return
	}
	if len(queued) == 0 {
		return
	}

	concurrency := getEnvInt("WEBHOOK_DELIVERY_CONCURRENCY", 10)
	if concurrency < 1 {
		concurrency = 1
	}
	if concurrency > 32 {
		concurrency = 32
	}
	sem := make(chan struct{}, concurrency)
	var wg sync.WaitGroup
	for _, item := range queued {
		item := item
		sem <- struct{}{}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			sm.deliverQueuedWebhook(item)
		}()
	}
	wg.Wait()
	if len(queued) == batchSize {
		select {
		case sm.deliveryWake <- struct{}{}:
		default:
		}
	}
}

func (sm *SessionManager) claimWebhookOutbox(limit int) ([]queuedWebhookEvent, error) {
	tx, err := sm.db.BeginTx(context.Background(), nil)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()

	rows, err := tx.QueryContext(context.Background(), `
		SELECT id, broker_id, payload, attempts
		FROM whatsapp_webhook_outbox
		WHERE next_attempt_at <= NOW()
		-- This order is backed by idx_whatsapp_webhook_outbox_due. The old
		-- JSON CASE priority forced a full sort of the entire backlog and made
		-- the claim statement time out, which stopped all message delivery.
		ORDER BY next_attempt_at, id
		LIMIT $1
		FOR UPDATE SKIP LOCKED`, limit)
	if err != nil {
		return nil, err
	}
	queued := make([]queuedWebhookEvent, 0, limit)
	for rows.Next() {
		var item queuedWebhookEvent
		if err := rows.Scan(&item.id, &item.brokerID, &item.payload, &item.attempts); err != nil {
			log.Printf("webhook outbox scan failed: %v", err)
			continue
		}
		queued = append(queued, item)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if len(queued) == 0 {
		if err := tx.Commit(); err != nil {
			return nil, err
		}
		return queued, nil
	}
	for _, item := range queued {
		if _, err := tx.ExecContext(context.Background(), `
			UPDATE whatsapp_webhook_outbox
			SET next_attempt_at = NOW() + INTERVAL '60 seconds'
			WHERE id = $1`, item.id); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return queued, nil
}

func (sm *SessionManager) deliverQueuedWebhook(item queuedWebhookEvent) {
	err := postWebhookPayload(item.payload)
	if err == nil {
		if _, deleteErr := sm.db.ExecContext(context.Background(),
			"DELETE FROM whatsapp_webhook_outbox WHERE id=$1", item.id); deleteErr != nil {
			log.Printf("[broker %s] webhook outbox delete failed: %v", item.brokerID, deleteErr)
		}
		return
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
