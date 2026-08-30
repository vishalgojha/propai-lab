-- Provider-neutral inbound lead evidence. These rows are tenant-private and
-- are deliberately separate from raw_messages / market inventory: a portal
-- or ad lead is a buyer enquiry, not a WhatsApp listing observation.
create table if not exists public.inbound_leads (
    id bigint generated always as identity primary key,
    tenant_id uuid not null references public.organizations(id) on delete cascade,
    provider text not null check (provider in ('meta', 'magicbricks', '99acres', 'website', 'manual')),
    external_lead_id text,
    idempotency_key text not null,
    contact_name text,
    contact_phone text,
    contact_email text,
    enquiry_text text,
    property_reference text,
    raw_payload jsonb not null default '{}',
    parsed_requirement jsonb not null default '{}',
    status text not null default 'received' check (status in ('received', 'matched', 'duplicate', 'failed')),
    error_message text,
    received_at timestamptz not null default now(),
    processed_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (tenant_id, provider, idempotency_key)
);

create index if not exists idx_inbound_leads_tenant_received
    on public.inbound_leads (tenant_id, received_at desc);
create index if not exists idx_inbound_leads_status
    on public.inbound_leads (tenant_id, status);

create table if not exists public.inbound_lead_matches (
    id bigint generated always as identity primary key,
    tenant_id uuid not null references public.organizations(id) on delete cascade,
    lead_id bigint not null references public.inbound_leads(id) on delete cascade,
    listing_id bigint not null,
    match_score numeric not null default 0,
    bhk_match boolean default false,
    market_match boolean default false,
    price_match numeric,
    building_match boolean,
    intent_match boolean default true,
    matched_at timestamptz not null default now(),
    unique (lead_id, listing_id)
);

create index if not exists idx_inbound_lead_matches_tenant_score
    on public.inbound_lead_matches (tenant_id, match_score desc, matched_at desc);

alter table public.inbound_leads enable row level security;
alter table public.inbound_lead_matches enable row level security;

drop policy if exists inbound_leads_service_role_all on public.inbound_leads;
create policy inbound_leads_service_role_all on public.inbound_leads
    for all to service_role using (true) with check (true);
drop policy if exists inbound_lead_matches_service_role_all on public.inbound_lead_matches;
create policy inbound_lead_matches_service_role_all on public.inbound_lead_matches
    for all to service_role using (true) with check (true);

drop trigger if exists set_inbound_leads_updated_at on public.inbound_leads;
create trigger set_inbound_leads_updated_at before update on public.inbound_leads
    for each row execute function public.trigger_market_requirements_updated_at();
