-- Keep the expiry-cleanup selector on only rows it can actually update.
-- This complements the broader pending-group queue index without changing data.
create index if not exists idx_raw_messages_expiry_eligible_created_at_id
  on public.raw_messages (created_at, id)
  where processed = false
    and is_group = true
    and coalesce(extraction_outcome, '') <> 'running';

analyze public.raw_messages;
