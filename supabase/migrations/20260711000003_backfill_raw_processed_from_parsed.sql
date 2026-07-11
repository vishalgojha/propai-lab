-- Keep extraction progress truthful after introducing raw_messages.processed.
-- Existing messages that already produced parsed_output should not appear as pending.

alter table if exists raw_messages
    add column if not exists processed boolean not null default false;

alter table if exists raw_messages
    add column if not exists processed_at timestamptz;

update raw_messages rm
set processed = true,
    processed_at = coalesce(rm.processed_at, rm.created_at, now())
where rm.processed = false
  and exists (
      select 1
      from parsed_output po
      where po.raw_message_id = rm.id
  );

create index if not exists idx_raw_messages_unprocessed
    on raw_messages(id)
    where processed = false;

create index if not exists idx_raw_messages_processed
    on raw_messages(processed, processed_at)
    where processed = true;
