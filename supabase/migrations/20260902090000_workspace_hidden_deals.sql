-- Workspace-only removal for My Deals.
-- This hides a broker's CRM reference without deleting typed inventory or its
-- original WhatsApp evidence.
create table if not exists public.workspace_hidden_deals (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  source_schema text not null,
  source_id bigint not null,
  hidden_by uuid references auth.users(id),
  hidden_at timestamptz not null default now(),
  unique (tenant_id, source_schema, source_id)
);

create index if not exists workspace_hidden_deals_lookup_idx
  on public.workspace_hidden_deals (tenant_id, source_schema, source_id);

alter table public.workspace_hidden_deals enable row level security;

drop policy if exists workspace_hidden_deals_select on public.workspace_hidden_deals;
create policy workspace_hidden_deals_select
  on public.workspace_hidden_deals for select using (
    app_private.is_super_admin() or tenant_id = any(select app_private.user_tenant_ids())
  );

drop policy if exists workspace_hidden_deals_insert on public.workspace_hidden_deals;
create policy workspace_hidden_deals_insert
  on public.workspace_hidden_deals for insert with check (
    app_private.is_super_admin() or tenant_id = any(select app_private.user_tenant_ids())
  );

drop policy if exists workspace_hidden_deals_delete on public.workspace_hidden_deals;
create policy workspace_hidden_deals_delete
  on public.workspace_hidden_deals for delete using (
    app_private.is_super_admin() or tenant_id = any(select app_private.user_tenant_ids())
  );
