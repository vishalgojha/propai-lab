-- Tenant-owned shortlist/pipeline references for shared market evidence.
-- This table never copies or mutates the source listing/requirement row.
create table if not exists public.workspace_market_candidates (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  source_schema text not null,
  source_id bigint not null,
  stage text not null default 'shortlisted'
    check (stage in ('shortlisted', 'contacted', 'viewing', 'closed', 'dismissed')),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, source_schema, source_id)
);

create index if not exists workspace_market_candidates_tenant_stage_idx
  on public.workspace_market_candidates (tenant_id, stage, updated_at desc);

alter table public.workspace_market_candidates enable row level security;

drop policy if exists workspace_market_candidates_select on public.workspace_market_candidates;
create policy workspace_market_candidates_select
  on public.workspace_market_candidates for select using (
    app_private.is_super_admin() or tenant_id = any(select app_private.user_tenant_ids())
  );

drop policy if exists workspace_market_candidates_insert on public.workspace_market_candidates;
create policy workspace_market_candidates_insert
  on public.workspace_market_candidates for insert with check (
    app_private.is_super_admin() or tenant_id = any(select app_private.user_tenant_ids())
  );

drop policy if exists workspace_market_candidates_update on public.workspace_market_candidates;
create policy workspace_market_candidates_update
  on public.workspace_market_candidates for update using (
    app_private.is_super_admin() or tenant_id = any(select app_private.user_tenant_ids())
  ) with check (
    app_private.is_super_admin() or tenant_id = any(select app_private.user_tenant_ids())
  );

drop policy if exists workspace_market_candidates_delete on public.workspace_market_candidates;
create policy workspace_market_candidates_delete
  on public.workspace_market_candidates for delete using (
    app_private.is_super_admin() or tenant_id = any(select app_private.user_tenant_ids())
  );
