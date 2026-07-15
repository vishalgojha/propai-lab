-- Add broker_id to org_whatsapp_connections for multi-phone support
-- Each phone gets a unique broker_id that links to its ingestor session

ALTER TABLE org_whatsapp_connections
  ADD COLUMN IF NOT EXISTS broker_id text UNIQUE;

-- Backfill existing rows with a UUID
UPDATE org_whatsapp_connections
  SET broker_id = gen_random_uuid()::text
  WHERE broker_id IS NULL;

-- Now make it NOT NULL with a default
ALTER TABLE org_whatsapp_connections
  ALTER COLUMN broker_id SET NOT NULL,
  ALTER COLUMN broker_id SET DEFAULT gen_random_uuid()::text;

-- Add index for quick lookups by broker_id
CREATE INDEX IF NOT EXISTS idx_org_whatsapp_broker_id
  ON org_whatsapp_connections(broker_id);
