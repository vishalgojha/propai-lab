-- Workspace-level broker suppression.
-- This deliberately hides a broker from one workspace's views without
-- deleting shared WhatsApp evidence or changing the global broker graph.
create table if not exists public.workspace_blocked_brokers (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  broker_key text not null,
  broker_name text not null default '',
  broker_phone text not null default '',
  reason text not null default '',
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (organization_id, broker_key)
);

create index if not exists idx_workspace_blocked_brokers_org
  on public.workspace_blocked_brokers(organization_id);

alter table public.workspace_blocked_brokers enable row level security;

drop policy if exists "tenant_select_workspace_blocked_brokers" on public.workspace_blocked_brokers;
create policy "tenant_select_workspace_blocked_brokers"
  on public.workspace_blocked_brokers for select
  using (public.is_super_admin() or organization_id = any(select public.user_tenant_ids()));

drop policy if exists "tenant_insert_workspace_blocked_brokers" on public.workspace_blocked_brokers;
create policy "tenant_insert_workspace_blocked_brokers"
  on public.workspace_blocked_brokers for insert
  with check (public.is_super_admin() or organization_id = any(select public.user_tenant_ids()));

drop policy if exists "tenant_delete_workspace_blocked_brokers" on public.workspace_blocked_brokers;
create policy "tenant_delete_workspace_blocked_brokers"
  on public.workspace_blocked_brokers for delete
  using (public.is_super_admin() or organization_id = any(select public.user_tenant_ids()));
