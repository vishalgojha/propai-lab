-- The extraction worker reconciles a bounded FIFO of repost observations on
-- every cycle. Keep that query on a narrow partial index instead of scanning
-- the full raw_messages table.
create index if not exists idx_raw_messages_repeat_pending_id
  on public.raw_messages (id)
  where processed = true
    and extraction_outcome = 'repeat_pending';
