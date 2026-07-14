-- Track 24h WhatsApp Business API session windows per conversation.
-- A session opens when a user sends a message; business can reply within 24h.
CREATE TABLE IF NOT EXISTS waba_sessions (
    chat_id         text PRIMARY KEY,
    last_user_at    timestamptz NOT NULL DEFAULT now(),
    session_active  boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_waba_sessions_last_user_at ON waba_sessions(last_user_at DESC);
CREATE INDEX IF NOT EXISTS idx_waba_sessions_active ON waba_sessions(session_active) WHERE session_active = true;

-- Add delivery_status column to raw_messages for tracking sent/delivered/read ticks.
ALTER TABLE raw_messages ADD COLUMN IF NOT EXISTS delivery_status text DEFAULT NULL;
ALTER TABLE raw_messages ADD COLUMN IF NOT EXISTS delivery_updated_at timestamptz DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_raw_messages_delivery ON raw_messages(delivery_status) WHERE delivery_status IS NOT NULL;
