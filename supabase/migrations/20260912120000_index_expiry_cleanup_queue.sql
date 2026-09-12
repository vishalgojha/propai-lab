-- Support the bounded expiry-maintenance RPC without scanning every pending
-- group message. The RPC filters created_at, then orders by created_at, id.
-- Keep this partial: processed rows and non-group evidence are not eligible.
create index if not exists idx_raw_messages_expiry_queue_created_at_id
  on public.raw_messages (created_at, id)
  where processed = false
    and is_group = true;

analyze public.raw_messages;
