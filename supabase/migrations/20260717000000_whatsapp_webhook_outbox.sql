-- Durable handoff between the WhatsMeow ingestor and the PropAI API.
CREATE TABLE IF NOT EXISTS whatsapp_webhook_outbox (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    broker_id TEXT NOT NULL,
    event_id TEXT NOT NULL UNIQUE,
    payload JSONB NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_webhook_outbox_due
    ON whatsapp_webhook_outbox (next_attempt_at, id);

ALTER TABLE whatsapp_webhook_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE whatsapp_webhook_outbox FROM anon, authenticated;
