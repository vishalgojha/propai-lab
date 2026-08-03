-- Market-wide demand projection.
--
-- client_requirements is the broker's CRM and is intentionally not used here.
-- This table is the demand-side counterpart to public.listings: every row is
-- traceable to one parsed WhatsApp observation and remains tenant-scoped.
create table if not exists public.market_requirements (
    id              bigint generated always as identity primary key,
    fingerprint     text not null unique,
    intent          text,
    transaction_type text,
    bhk             text,
    price_min       numeric,
    price_max       numeric,
    price_unit      text not null default 'INR',
    area_sqft       numeric,
    location_label  text,
    building_name   text,
    landmark_name   text,
    micro_market    text,
    broker_id       bigint references public.brokers(id) on delete set null,
    broker_name     text,
    broker_phone    text,
    raw_message_id  bigint references public.raw_messages(id) on delete cascade,
    confidence      numeric not null default 0,
    first_seen      timestamptz not null default now(),
    last_seen       timestamptz not null default now(),
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    tenant_id       uuid not null references public.organizations(id) on delete cascade
);

create index if not exists idx_market_requirements_tenant
    on public.market_requirements(tenant_id);
create index if not exists idx_market_requirements_micro_market
    on public.market_requirements(micro_market);
create index if not exists idx_market_requirements_intent
    on public.market_requirements(intent);
create index if not exists idx_market_requirements_bhk
    on public.market_requirements(bhk);
create index if not exists idx_market_requirements_broker_phone
    on public.market_requirements(broker_phone);
create index if not exists idx_market_requirements_created_at
    on public.market_requirements(created_at desc);
create index if not exists idx_market_requirements_last_seen
    on public.market_requirements(last_seen desc);

create or replace function public.trigger_market_requirements_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

drop trigger if exists set_market_requirements_updated_at on public.market_requirements;
create trigger set_market_requirements_updated_at
    before update on public.market_requirements
    for each row execute function public.trigger_market_requirements_updated_at();

alter table public.market_requirements enable row level security;

-- The API uses its tenant-scoped service-role storage layer, which applies
-- tenant_id to every read/write. No direct authenticated-table access is
-- granted here because this project has no app_private tenant helper schema.
drop policy if exists "service_role_all_market_requirements" on public.market_requirements;
create policy "service_role_all_market_requirements"
    on public.market_requirements for all to service_role
    using (true) with check (true);

-- Existing parsed demand rows are copied by the application backfill after
-- deploy. Keeping the backfill outside the DDL makes it resumable and lets it
-- use the same broker identity and price-normalisation code as live ingestion.
