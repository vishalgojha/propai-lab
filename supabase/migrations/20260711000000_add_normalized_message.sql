-- Add normalized_message column to parsed_output for search/indexing
-- Run this migration after 20260709000000_multi_tenant_rbac.sql

-- ── Add normalized_message column ────────────────────────────────────
alter table parsed_output add column if not exists normalized_message text;

-- ── Index for full-text search on normalized message ────────────────
create index if not exists idx_parsed_normalized_message on parsed_output using gin(to_tsvector('english', coalesce(normalized_message, '')));