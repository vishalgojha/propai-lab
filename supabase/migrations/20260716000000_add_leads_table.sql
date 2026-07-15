-- Public lead capture table for www.portal
create table if not exists public.leads (
    id bigint generated always as identity primary key,
    listing_id bigint not null references public.listings(id) on delete cascade,
    broker_id bigint references public.brokers(id) on delete set null,
    client_name text not null,
    client_phone text not null,
    message text,
    source text not null default 'www_portal',
    status text not null default 'new' check (status in ('new', 'notified', 'notify_failed', 'contacted')),
    notify_error text,
    created_at timestamptz not null default now()
);

create index if not exists idx_leads_listing_id on public.leads(listing_id);
create index if not exists idx_leads_broker_id on public.leads(broker_id);
create index if not exists idx_leads_status on public.leads(status);
create index if not exists idx_leads_created_at on public.leads(created_at desc);

-- Enable RLS but allow public access via service role
alter table public.leads enable row level security;

-- Public insert policy for /public/leads endpoint (service role only)
create policy "leads_public_insert" on public.leads
    for insert to service_role
    with check (true);

-- Service role can read all leads
create policy "leads_service_read" on public.leads
    for select to service_role
    using (true);