create table if not exists public.saved_market_searches (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  query_text text not null,
  filters jsonb not null default '{}',
  saved_at timestamptz not null default now(),
  last_viewed_at timestamptz,
  last_seen_record_at timestamptz,
  created_by uuid references auth.users(id),
  unique (tenant_id, name)
);

create index if not exists saved_market_searches_tenant_saved_idx
  on public.saved_market_searches (tenant_id, saved_at desc);

alter table public.saved_market_searches enable row level security;

drop policy if exists saved_market_searches_select on public.saved_market_searches;
create policy saved_market_searches_select on public.saved_market_searches
  for select using (app_private.is_super_admin() or tenant_id = any(select app_private.user_tenant_ids()));

drop policy if exists saved_market_searches_insert on public.saved_market_searches;
create policy saved_market_searches_insert on public.saved_market_searches
  for insert with check (app_private.is_super_admin() or tenant_id = any(select app_private.user_tenant_ids()));

drop policy if exists saved_market_searches_update on public.saved_market_searches;
create policy saved_market_searches_update on public.saved_market_searches
  for update using (app_private.is_super_admin() or tenant_id = any(select app_private.user_tenant_ids()))
  with check (app_private.is_super_admin() or tenant_id = any(select app_private.user_tenant_ids()));

drop policy if exists saved_market_searches_delete on public.saved_market_searches;
create policy saved_market_searches_delete on public.saved_market_searches
  for delete using (app_private.is_super_admin() or tenant_id = any(select app_private.user_tenant_ids()));
