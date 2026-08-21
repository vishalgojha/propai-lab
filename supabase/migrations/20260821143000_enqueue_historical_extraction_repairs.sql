-- Enqueue already-processed broadcast parents that have deterministic child
-- slices but were never registered in the repair queue. This migration does
-- not delete or rewrite raw evidence; the repair runner materializes children
-- and marks the parent superseded only after successful child creation.
--
-- Idempotency is provided by extraction_repair_jobs.parent_raw_id.
insert into public.extraction_repair_jobs (
  tenant_id,
  parent_raw_id,
  status,
  existing_parsed_count
)
select
  parent.tenant_id,
  parent.id,
  'queued',
  0
from public.raw_messages parent
where parent.processed = true
  and coalesce(parent.extraction_superseded, false) = false
  and parent.parent_message_id is null
  and exists (
    select 1
    from public.raw_messages child
    where child.parent_message_id = parent.id
  )
on conflict (parent_raw_id) do nothing;

create index if not exists idx_raw_messages_parent_split_lookup
  on public.raw_messages(parent_message_id, processed, split_index);

notify pgrst, 'reload schema';
