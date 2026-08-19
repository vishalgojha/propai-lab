-- Keep every WhatsApp event as raw evidence, but prevent identical broker
-- broadcasts from re-entering LLM extraction.
alter table if exists public.raw_messages
    add column if not exists author_content_fingerprint text;

alter table if exists public.raw_messages
    add column if not exists repeat_of_raw_message_id bigint references public.raw_messages(id);

create index if not exists idx_raw_messages_author_content_fingerprint
    on public.raw_messages (tenant_id, author_content_fingerprint, processed, id);
