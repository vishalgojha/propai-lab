-- Durable, tenant-scoped cache for evidence-backed entity enrichment.
-- This is not an inventory table and must never be used to create or merge listings.
create table if not exists public.entity_enrichment_cache (
    id                  bigint generated always as identity primary key,
    scope_key           text not null,
    entity_type         text not null check (entity_type in ('building', 'locality', 'landmark')),
    entity_key          text not null,
    provider            text not null,
    cache_version       text not null,
    evidence_fingerprint text not null,
    result              jsonb not null default '{}',
    confidence          numeric not null default 0,
    source_url          text,
    source_record_id    text,
    expires_at          timestamptz not null,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now(),
    unique (scope_key, entity_type, entity_key, provider, cache_version, evidence_fingerprint)
);

create index if not exists entity_enrichment_cache_lookup_idx
    on public.entity_enrichment_cache (scope_key, entity_type, entity_key, provider, expires_at desc);

create index if not exists entity_enrichment_cache_expiry_idx
    on public.entity_enrichment_cache (expires_at);

alter table public.entity_enrichment_cache enable row level security;

drop policy if exists entity_enrichment_cache_service_only on public.entity_enrichment_cache;
create policy entity_enrichment_cache_service_only
    on public.entity_enrichment_cache for all
    using (auth.role() = 'service_role')
    with check (auth.role() = 'service_role');
