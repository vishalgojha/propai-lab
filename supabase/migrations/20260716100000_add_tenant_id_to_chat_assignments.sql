-- Add tenant_id to chat_assignments for multi-tenant scoping
ALTER TABLE chat_assignments ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES organizations(id);

-- Backfill existing rows using the phone→org mapping
UPDATE chat_assignments ca
SET tenant_id = owc.organization_id
FROM org_whatsapp_connections owc
WHERE ca.tenant_id IS NULL
  AND owc.phone_number = ca.whatsapp_number;

-- Create index for efficient tenant-scoped queries
CREATE INDEX IF NOT EXISTS idx_chat_assignments_tenant_id ON chat_assignments(tenant_id);

-- Set NOT NULL after backfill
ALTER TABLE chat_assignments ALTER COLUMN tenant_id SET NOT NULL;
