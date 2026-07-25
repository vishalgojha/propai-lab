-- Onboarding group controls, tier caps, and cross-tenant broker overlap registry.

alter table public.organizations
  add column if not exists subscription_tier text not null default 'starter',
  add column if not exists group_cap_override integer,
  add column if not exists group_cap_override_reason text not null default '';

alter table public.organizations
  drop constraint if exists organizations_subscription_tier_check,
  add constraint organizations_subscription_tier_check
    check (subscription_tier in ('starter', 'growth', 'scale', 'custom')),
  drop constraint if exists organizations_group_cap_override_check,
  add constraint organizations_group_cap_override_check
    check (group_cap_override is null or group_cap_override > 0);

create table if not exists public.organization_group_connections (
    id bigint generated always as identity primary key,
    organization_id uuid not null references public.organizations(id) on delete cascade,
    whatsapp_connection_id bigint not null references public.org_whatsapp_connections(id) on delete cascade,
    group_jid text not null,
    group_name text not null default '',
    is_active boolean not null default true,
    overlap_score numeric(6,5),
    overlap_sample_count integer not null default 0,
    overlap_shared_count integer not null default 0,
    overlap_confirmed boolean not null default false,
    connected_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (organization_id, whatsapp_connection_id, group_jid)
);

create index if not exists idx_org_group_connections_org
  on public.organization_group_connections(organization_id, is_active);
create index if not exists idx_org_group_connections_phone
  on public.organization_group_connections(whatsapp_connection_id, is_active);

create table if not exists public.network_broker_registry (
    broker_phone text primary key,
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    tenant_count integer not null default 0,
    group_count integer not null default 0,
    confidence numeric(6,5) not null default 0,
    updated_at timestamptz not null default now()
);

create table if not exists public.network_broker_group_presence (
    id bigint generated always as identity primary key,
    broker_phone text not null references public.network_broker_registry(broker_phone) on delete cascade,
    organization_id uuid not null references public.organizations(id) on delete cascade,
    group_jid text not null,
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    source text not null default 'onboarding_sample',
    unique (broker_phone, organization_id, group_jid)
);

create index if not exists idx_network_presence_phone
  on public.network_broker_group_presence(broker_phone);
create index if not exists idx_network_presence_org_group
  on public.network_broker_group_presence(organization_id, group_jid);

drop trigger if exists set_organization_group_connections_updated_at
  on public.organization_group_connections;
create trigger set_organization_group_connections_updated_at
before update on public.organization_group_connections
for each row execute function public.trigger_set_updated_at();

alter table public.organization_group_connections enable row level security;
alter table public.network_broker_registry enable row level security;
alter table public.network_broker_group_presence enable row level security;

drop policy if exists "organization members can read group connections"
  on public.organization_group_connections;
create policy "organization members can read group connections"
on public.organization_group_connections for select to authenticated
using (exists (
    select 1 from public.organization_members member
    where member.organization_id = organization_group_connections.organization_id
      and member.user_id = (select auth.uid())
      and member.is_active = true
));

drop policy if exists "organization members can manage group connections"
  on public.organization_group_connections;
create policy "organization members can add group connections"
on public.organization_group_connections for insert to authenticated
with check (exists (
    select 1 from public.organization_members member
    where member.organization_id = organization_group_connections.organization_id
      and member.user_id = (select auth.uid())
      and member.is_active = true
));

drop policy if exists "organization members can edit group connections"
  on public.organization_group_connections;
create policy "organization members can edit group connections"
on public.organization_group_connections for update to authenticated
using (exists (
    select 1 from public.organization_members member
    where member.organization_id = organization_group_connections.organization_id
      and member.user_id = (select auth.uid())
      and member.is_active = true
))
with check (exists (
    select 1 from public.organization_members member
    where member.organization_id = organization_group_connections.organization_id
      and member.user_id = (select auth.uid())
      and member.is_active = true
));

drop policy if exists "organization members can delete group connections"
  on public.organization_group_connections;
create policy "organization members can delete group connections"
on public.organization_group_connections for delete to authenticated
using (exists (
    select 1 from public.organization_members member
    where member.organization_id = organization_group_connections.organization_id
      and member.user_id = (select auth.uid())
      and member.is_active = true
));

drop policy if exists "service role manages network broker registry"
  on public.network_broker_registry;
create policy "service role manages network broker registry"
on public.network_broker_registry for all to service_role
using (true) with check (true);

drop policy if exists "service role manages network broker presence"
  on public.network_broker_group_presence;
create policy "service role manages network broker presence"
on public.network_broker_group_presence for all to service_role
using (true) with check (true);
