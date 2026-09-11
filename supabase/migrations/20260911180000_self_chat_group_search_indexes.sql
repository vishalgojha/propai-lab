-- Keep tenant-scoped WhatsApp evidence searches bounded as raw_messages grows.
-- The agent tool uses wildcard ILIKE over message, group_name, and sender.
create extension if not exists pg_trgm;

create index if not exists idx_raw_messages_tenant_timestamp
  on public.raw_messages (tenant_id, "timestamp" desc, id desc);

create index if not exists idx_raw_messages_message_trgm
  on public.raw_messages using gin (message gin_trgm_ops);

create index if not exists idx_raw_messages_group_name_trgm
  on public.raw_messages using gin (group_name gin_trgm_ops);

create index if not exists idx_raw_messages_sender_trgm
  on public.raw_messages using gin (sender gin_trgm_ops);
