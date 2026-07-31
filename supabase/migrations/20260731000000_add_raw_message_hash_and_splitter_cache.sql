-- ============================================================================
-- Raw message hash + sender splitter cache
-- ============================================================================

alter table if exists public.raw_messages
    add column if not exists message_hash text;

create index if not exists idx_raw_messages_hash
    on public.raw_messages (message_hash);

create index if not exists idx_raw_messages_hash_processed
    on public.raw_messages (message_hash, processed);

create table if not exists public.raw_message_splitter_cache (
    id                 bigint generated always as identity primary key,
    tenant_id          uuid references public.organizations(id) on delete cascade,
    sender_key         text not null,
    sender_phone       text,
    sender_jid         text,
    pattern_id         text not null,
    message_count      integer not null default 0,
    validated_count    integer not null default 0,
    last_message_hash  text,
    last_seen_at       timestamptz,
    last_validated_at  timestamptz,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    unique (tenant_id, sender_key)
);

create index if not exists idx_raw_message_splitter_cache_sender
    on public.raw_message_splitter_cache (sender_key);

create index if not exists idx_raw_message_splitter_cache_tenant_sender
    on public.raw_message_splitter_cache (tenant_id, sender_key);

alter table public.raw_message_splitter_cache enable row level security;

