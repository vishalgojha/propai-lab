-- ============================================================================
-- Add index on created_at for raw_messages (audit queries)
-- ============================================================================
-- The audit endpoint queries raw_messages by created_at (e.g., "WHERE created_at >= today_start")
-- Adding this index will speed up those queries significantly.
-- ============================================================================

create index if not exists idx_raw_messages_created_at 
on public.raw_messages using btree (created_at desc);