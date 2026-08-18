-- Explicit cold-start market preferences for broker workspaces.
create table if not exists public.workspace_market_preferences (
  tenant_id uuid primary key references public.organizations(id) on delete cascade,
  primary_localities text[] not null default '{}',
  nearby_localities text[] not null default '{}',
  transaction_types text[] not null default '{sale,rent}',
  asset_types text[] not null default '{residential,commercial}',
  onboarding_completed boolean not null default false,
  source text not null default 'explicit',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_workspace_market_preferences_tenant
  on public.workspace_market_preferences(tenant_id);

alter table public.workspace_market_preferences enable row level security;
drop policy if exists "tenant_select_workspace_market_preferences" on public.workspace_market_preferences;
create policy "tenant_select_workspace_market_preferences" on public.workspace_market_preferences
  for select using (public.is_super_admin() or tenant_id = any(select public.user_tenant_ids()));
drop policy if exists "tenant_insert_workspace_market_preferences" on public.workspace_market_preferences;
create policy "tenant_insert_workspace_market_preferences" on public.workspace_market_preferences
  for insert with check (public.is_super_admin() or tenant_id = any(select public.user_tenant_ids()));
drop policy if exists "tenant_update_workspace_market_preferences" on public.workspace_market_preferences;
create policy "tenant_update_workspace_market_preferences" on public.workspace_market_preferences
  for update using (public.is_super_admin() or tenant_id = any(select public.user_tenant_ids()))
  with check (public.is_super_admin() or tenant_id = any(select public.user_tenant_ids()));
