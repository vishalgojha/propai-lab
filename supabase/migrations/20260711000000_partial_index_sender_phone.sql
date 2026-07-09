-- Create partial index to support sender_phone backfill
-- This allows the UPDATE to quickly find rows where sender_phone is NULL or empty

CREATE INDEX IF NOT EXISTS idx_raw_messages_sender_phone_backfill
ON raw_messages (sender_jid)
WHERE sender_phone IS NULL OR sender_phone = '';