CREATE TABLE IF NOT EXISTS whatsapp_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id UUID NOT NULL,
    broker_id TEXT NOT NULL DEFAULT '',
    event_type TEXT NOT NULL,
    chat_jid TEXT NOT NULL DEFAULT '',
    sender_jid TEXT NOT NULL DEFAULT '',
    message_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_events_tenant_time
    ON whatsapp_events (tenant_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_events_message_ids
    ON whatsapp_events USING GIN (message_ids);

ALTER TABLE whatsapp_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE whatsapp_events FROM anon, authenticated;
