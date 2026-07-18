-- One optional WhatsApp Business Cloud API connection per workspace.
-- Credentials are server-only: authenticated browser clients have no direct
-- table privileges and the API never returns stored token values.
create table if not exists public.org_waba_connections (
    id bigint generated always as identity primary key,
    organization_id uuid not null references public.organizations(id) on delete cascade,
    whatsapp_business_number text not null,
    phone_number_id text not null,
    access_token text not null,
    verify_token text not null,
    is_active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint org_waba_connections_organization_key unique (organization_id),
    constraint org_waba_connections_phone_number_id_key unique (phone_number_id)
);

create index if not exists idx_org_waba_connections_active
    on public.org_waba_connections (is_active, organization_id);

alter table public.org_waba_connections enable row level security;

revoke all on table public.org_waba_connections from anon, authenticated;
grant select, insert, update, delete on table public.org_waba_connections to service_role;
grant usage, select on sequence public.org_waba_connections_id_seq to service_role;

drop policy if exists "Service role manages workspace WABA connections"
    on public.org_waba_connections;
create policy "Service role manages workspace WABA connections"
    on public.org_waba_connections
    for all
    to service_role
    using (true)
    with check (true);

comment on table public.org_waba_connections is
    'Server-only WhatsApp Business Cloud API credentials scoped to one organization.';
