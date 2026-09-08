-- Keep the workspace extraction-progress aggregate index-only on the large
-- raw-message ledger. Replace the old tenant-only index under its existing
-- name so the planner does not choose a heap-reading alternative.
drop index if exists public.idx_raw_messages_tenant;
create index if not exists idx_raw_messages_tenant
  on public.raw_messages (tenant_id)
  include (processed, processed_at, extraction_suppressed);

analyze public.raw_messages;
