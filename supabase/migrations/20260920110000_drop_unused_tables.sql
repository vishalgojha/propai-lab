-- Drop never-used tables identified in the 2026-09-20 usage audit.
-- Cross-referenced against propai-lab + chariotrealty runtime code: none of
-- these are read or written by any live path (only referenced by old
-- migrations/one-off scripts). No dependent views/functions/FKs.
-- whatsmeow_* library tables, jid_*, observations, activity_log, leads,
-- clients are intentionally retained.

drop table if exists public.llm_routing_log;
drop table if exists public.webhook_outbox_archive;
drop table if exists public.market_requirements_legacy;
drop table if exists public.chat_assignments;
drop table if exists public.cleanup_audit_log;

-- broker_team_evidence is not read anywhere, but broker_team_members keeps
-- primary_evidence_id as an opaque id (never joined). Drop the FK so the
-- table can be removed; the column stays as a plain reference.
alter table public.broker_team_members
  drop constraint if exists broker_team_members_primary_evidence_id_fkey;
drop table if exists public.broker_team_evidence;