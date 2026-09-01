-- Cross-tenant exact-copy reuse for successful extraction output.
-- Raw messages and typed rows remain tenant-owned evidence; this table stores
-- only versioned model output keyed by the conservative content hash.

create table if not exists public.shared_extraction_results (
  id bigint generated always as identity primary key,
  content_hash text not null unique,
  extraction jsonb not null,
  provider_used text,
  item_count integer not null default 0,
  hit_count integer not null default 0,
  created_at timestamptz not null default now(),
  last_hit_at timestamptz
);

create table if not exists public.shared_extraction_observations (
  raw_message_id bigint primary key references public.raw_messages(id) on delete cascade,
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  shared_result_id bigint not null references public.shared_extraction_results(id) on delete cascade,
  outcome text not null check (outcome in ('origin', 'reused')),
  created_at timestamptz not null default now()
);

create index if not exists shared_extraction_observations_tenant_idx
  on public.shared_extraction_observations (tenant_id, created_at desc);

alter table public.shared_extraction_results enable row level security;
alter table public.shared_extraction_observations enable row level security;

drop policy if exists shared_extraction_results_service_role on public.shared_extraction_results;
create policy shared_extraction_results_service_role
  on public.shared_extraction_results for all to service_role
  using (true) with check (true);

drop policy if exists shared_extraction_observations_service_role on public.shared_extraction_observations;
create policy shared_extraction_observations_service_role
  on public.shared_extraction_observations for all to service_role
  using (true) with check (true);

revoke all on table public.shared_extraction_results from anon, authenticated;
revoke all on table public.shared_extraction_observations from anon, authenticated;
grant all on table public.shared_extraction_results to service_role;
grant all on table public.shared_extraction_observations to service_role;

create or replace function public.increment_shared_extraction_hit(p_id bigint)
returns void
language sql
security definer
set search_path = public
as $fn$
  update public.shared_extraction_results
     set hit_count = hit_count + 1, last_hit_at = now()
   where id = p_id;
$fn$;

revoke execute on function public.increment_shared_extraction_hit(bigint) from public, anon, authenticated;
grant execute on function public.increment_shared_extraction_hit(bigint) to service_role;
