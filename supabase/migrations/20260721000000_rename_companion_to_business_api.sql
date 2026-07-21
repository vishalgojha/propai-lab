-- Rename companion_* tables → business_api_* (Meta WABA clarity)
-- Previously the WABA (WhatsApp Business API) inbound + dashboard code was
-- named "companion", which collided conceptually with the whatsmeow
-- "self-chat" agent. Rename to "business-api" so the two features are
-- disambiguated in logs, code, and schema.
--
-- RLS policies and unique constraint names auto-update via the rename,
-- except the explicitly-named UNIQUE constraint on
-- companion_team_members.mobile_number which we rename explicitly.

ALTER TABLE IF EXISTS companion_config          RENAME TO business_api_config;
ALTER TABLE IF EXISTS companion_team_members    RENAME TO business_api_team_members;
ALTER TABLE IF EXISTS companion_conversations   RENAME TO business_api_conversations;
ALTER TABLE IF EXISTS companion_messages        RENAME TO business_api_messages;
ALTER TABLE IF EXISTS companion_audit_log       RENAME TO business_api_audit_log;

-- Rename the explicit-name UNIQUE constraint (auto-named index follows).
ALTER TABLE IF EXISTS business_api_team_members
    RENAME CONSTRAINT companion_team_members_mobile_number_key
    TO business_api_team_members_mobile_number_key;

-- Rename the RLS policies so their names match the new tables.
ALTER POLICY IF EXISTS service_role_all_companion_config          ON business_api_config          RENAME TO service_role_all_business_api_config;
ALTER POLICY IF EXISTS service_role_all_companion_team_members    ON business_api_team_members    RENAME TO service_role_all_business_api_team_members;
ALTER POLICY IF EXISTS service_role_all_companion_conversations   ON business_api_conversations   RENAME TO service_role_all_business_api_conversations;
ALTER POLICY IF EXISTS service_role_all_companion_messages        ON business_api_messages        RENAME TO service_role_all_business_api_messages;
ALTER POLICY IF EXISTS service_role_all_companion_audit_log       ON business_api_audit_log       RENAME TO service_role_all_business_api_audit_log;

-- Backfill processed=true on the 2 orphan rows from 2026-07-18/19 that were
-- written by the old WABA webhook path with msg_type='unsupported' (Meta
-- sends type=unsupported for voice calls / payments / etc that have no
-- text body). These have empty raw_payload and no parsed_output, so they
-- would otherwise keep showing up in unprocessed debug views.
UPDATE raw_messages
SET processed = true,
    processed_at = coalesce(processed_at, now())
WHERE message_type = 'unsupported'
  AND processed = false;
