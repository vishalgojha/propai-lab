-- Add processed flag to raw_messages for async worker pattern
alter table if exists raw_messages
    add column if not exists processed boolean not null default false;

alter table if exists raw_messages
    add column if not exists processed_at timestamptz;

create index if not exists idx_raw_messages_unprocessed
    on raw_messages(id)
    where processed = false;

create index if not exists idx_raw_messages_processed
    on raw_messages(processed, processed_at)
    where processed = true;
