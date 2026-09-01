-- Align the hot extraction scans with their complete predicates.
-- The existing tenant-leading indexes are useful when a tenant is supplied,
-- but the worker also runs global lanes ordered by id or message timestamp.
create index if not exists idx_raw_messages_pending_group_id
  on public.raw_messages (id)
  where processed = false
    and extraction_suppressed = false
    and is_group = true;

create index if not exists idx_raw_messages_pending_group_timestamp_id
  on public.raw_messages ("timestamp", id)
  where processed = false
    and extraction_suppressed = false
    and is_group = true;

-- shared_result_id is a foreign key used by cleanup and result fan-out joins.
create index if not exists idx_shared_extraction_observations_shared_result_id
  on public.shared_extraction_observations (shared_result_id);
