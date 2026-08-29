alter table public.tenant_boundary_review_queue
  add column if not exists locked_at timestamptz,
  add column if not exists locked_by text;

create index if not exists idx_tenant_boundary_review_queue_replay
  on public.tenant_boundary_review_queue(decision, locked_at, created_at);

create or replace function public.claim_tenant_boundary_replays(p_limit integer default 25)
returns setof public.tenant_boundary_review_queue
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query
  with picked as (
    select q.id
    from public.tenant_boundary_review_queue q
    where q.decision = 'replay'
      and q.locked_at is null
    order by q.created_at, q.id
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 25), 100))
  )
  update public.tenant_boundary_review_queue q
  set locked_at = now(),
      locked_by = coalesce(current_setting('request.jwt.claim.sub', true), 'tenant-boundary-worker'),
      updated_at = now()
  from picked
  where q.id = picked.id
  returning q.*;
end;
$$;

revoke all on function public.claim_tenant_boundary_replays(integer) from public, anon, authenticated;
grant execute on function public.claim_tenant_boundary_replays(integer) to service_role;
