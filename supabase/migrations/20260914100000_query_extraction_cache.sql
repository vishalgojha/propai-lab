-- Versioned, rebuildable results for bounded query-time extraction.
-- Raw WhatsApp evidence remains in raw_messages; this table is disposable.
create table if not exists public.query_extraction_cache (
    id bigint generated always as identity primary key,
    tenant_id uuid not null references public.organizations(id) on delete cascade,
    raw_message_id bigint not null references public.raw_messages(id) on delete cascade,
    source_slice_hash text not null,
    extractor_version text not null,
    extracted_payload jsonb not null default '{}',
    provider_used text,
    provider_model text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (tenant_id, raw_message_id, source_slice_hash, extractor_version)
);

create index if not exists idx_query_extraction_cache_tenant_message
    on public.query_extraction_cache (tenant_id, raw_message_id, updated_at desc);

alter table public.query_extraction_cache enable row level security;
drop policy if exists query_extraction_cache_service_role_all on public.query_extraction_cache;
create policy query_extraction_cache_service_role_all on public.query_extraction_cache
    for all to service_role using (true) with check (true);

drop trigger if exists set_query_extraction_cache_updated_at on public.query_extraction_cache;
create trigger set_query_extraction_cache_updated_at before update on public.query_extraction_cache
    for each row execute function public.trigger_market_requirements_updated_at();
