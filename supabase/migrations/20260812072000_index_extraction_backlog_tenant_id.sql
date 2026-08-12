-- Matches the historical extraction lane:
-- tenant-scoped, eligible rows ordered by raw_messages.id.
-- The worker creates this concurrently in production as part of the rollout;
-- keep the migration for reproducibility in new environments.
create index if not exists idx_raw_messages_pending_tenant_id
  on public.raw_messages (tenant_id, id)
  where processed = false
    and extraction_suppressed = false
    and is_group = true;
