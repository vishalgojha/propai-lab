-- Support bounded recovery of rows suppressed before their group was selected.
-- The worker still limits each recovery pass; this index avoids a full queue scan.
create index if not exists idx_raw_messages_suppressed_reenable
  on public.raw_messages (tenant_id, group_name, id)
  where processed = false and extraction_suppressed = true;
