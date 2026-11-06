-- Tenant-scoped, revocable credentials for external agent integrations.
-- Store only a SHA-256 digest; the raw token is returned once by the API.
create table if not exists public.external_agent_api_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid not null references auth.users(id) on delete restrict,
  label text not null default 'External agent',
  key_prefix text not null,
  key_hash text not null unique,
  scopes text[] not null default array['inventory:read', 'requirements:read', 'matches:read'],
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_external_agent_api_keys_tenant
  on public.external_agent_api_keys(tenant_id, created_at desc);
create index if not exists idx_external_agent_api_keys_hash
  on public.external_agent_api_keys(key_hash)
  where revoked_at is null;

alter table public.external_agent_api_keys enable row level security;

drop policy if exists external_agent_api_keys_member_select on public.external_agent_api_keys;
create policy external_agent_api_keys_member_select
on public.external_agent_api_keys for select to authenticated
using (exists (
  select 1 from public.organization_members m
  where m.organization_id = external_agent_api_keys.tenant_id
    and m.user_id = (select auth.uid())
    and m.is_active = true
));

drop policy if exists external_agent_api_keys_member_insert on public.external_agent_api_keys;
create policy external_agent_api_keys_member_insert
on public.external_agent_api_keys for insert to authenticated
with check (exists (
  select 1 from public.organization_members m
  where m.organization_id = external_agent_api_keys.tenant_id
    and m.user_id = (select auth.uid())
    and m.is_active = true
));

drop policy if exists external_agent_api_keys_member_update on public.external_agent_api_keys;
create policy external_agent_api_keys_member_update
on public.external_agent_api_keys for update to authenticated
using (exists (
  select 1 from public.organization_members m
  where m.organization_id = external_agent_api_keys.tenant_id
    and m.user_id = (select auth.uid())
    and m.is_active = true
))
with check (exists (
  select 1 from public.organization_members m
  where m.organization_id = external_agent_api_keys.tenant_id
    and m.user_id = (select auth.uid())
    and m.is_active = true
));
