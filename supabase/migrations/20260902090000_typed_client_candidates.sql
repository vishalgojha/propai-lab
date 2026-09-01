-- Keep client shortlists linked to the typed market source that was selected.
-- A legacy listings FK is not sufficient because the market has several typed
-- listing tables and their ids are only unique within each source table.
alter table public.client_property_candidates
  add column if not exists tenant_id uuid references public.organizations(id) on delete cascade,
  add column if not exists source_schema text,
  add column if not exists source_id bigint;

create index if not exists idx_client_candidates_tenant_source
  on public.client_property_candidates (tenant_id, source_schema, source_id);

create unique index if not exists client_property_candidates_client_source_key
  on public.client_property_candidates (client_id, source_schema, source_id)
  where source_schema is not null and source_id is not null;

alter table public.client_property_candidates enable row level security;

drop policy if exists client_property_candidates_select on public.client_property_candidates;
create policy client_property_candidates_select
  on public.client_property_candidates for select using (
    app_private.is_super_admin() or tenant_id = any(select app_private.user_tenant_ids())
  );

drop policy if exists client_property_candidates_insert on public.client_property_candidates;
create policy client_property_candidates_insert
  on public.client_property_candidates for insert with check (
    app_private.is_super_admin() or tenant_id = any(select app_private.user_tenant_ids())
  );

drop policy if exists client_property_candidates_update on public.client_property_candidates;
create policy client_property_candidates_update
  on public.client_property_candidates for update using (
    app_private.is_super_admin() or tenant_id = any(select app_private.user_tenant_ids())
  ) with check (
    app_private.is_super_admin() or tenant_id = any(select app_private.user_tenant_ids())
  );

drop policy if exists client_property_candidates_delete on public.client_property_candidates;
create policy client_property_candidates_delete
  on public.client_property_candidates for delete using (
    app_private.is_super_admin() or tenant_id = any(select app_private.user_tenant_ids())
  );
