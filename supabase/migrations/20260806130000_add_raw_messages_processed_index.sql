-- Keep the worker's existence check cheap even as the raw-message backlog grows.
-- The Supabase migration runner executes migrations in a transaction, so this
-- uses the transaction-safe form of CREATE INDEX rather than CONCURRENTLY.
create index if not exists idx_raw_messages_processed_false
on public.raw_messages (id)
where processed = false;
