-- Canonical, bounded extraction accounting for both Connections and Super
-- Admin. The old REST implementation issued multiple exact scans and
-- downloaded the whole AI usage log on every page load.
create index if not exists idx_raw_messages_progress_tenant_processed
  on public.raw_messages (tenant_id, processed, processed_at);
create index if not exists idx_ai_usage_log_extraction_tenant_created
  on public.ai_usage_log (tenant_id, agent, created_at);

create or replace function public.get_extraction_progress(
  p_hours integer default 24,
  p_tenant_id uuid default null
)
returns jsonb language sql security definer set search_path = public
as $$
with raw as (
  select count(*)::bigint total,
    count(*) filter (where not coalesce(r.processed, false))::bigint unprocessed,
    count(*) filter (where not coalesce(r.processed, false) and r.processed_at is not null)::bigint stuck,
    count(*) filter (where coalesce(r.processed, false) and r.processed_at >= now() - make_interval(hours => greatest(coalesce(p_hours, 24), 1)))::bigint processed_recent
  from public.raw_messages r
  where p_tenant_id is null or r.tenant_id = p_tenant_id
), usage as (
  select count(*)::bigint calls, coalesce(sum(coalesce(u.cost_usd, 0)), 0)::numeric cost
  from public.ai_usage_log u
  where u.agent = 'extraction' and (p_tenant_id is null or u.tenant_id = p_tenant_id)
), cache as (
  select count(*)::bigint rows from public.extraction_cache c
  where p_tenant_id is null or c.tenant_id = p_tenant_id
), tenant_rows as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'tenant_id', x.tenant_id,
    'organization_name', coalesce(o.name, x.tenant_id::text),
    'total_raw_messages', x.total, 'processed', x.processed,
    'unprocessed', x.unprocessed, 'stuck', x.stuck,
    'processed_recent', x.processed_recent,
    'percent_drained', case when x.total = 0 then 0 else round(x.processed * 100.0 / x.total, 2) end
  ) order by x.total desc), '[]'::jsonb) value
  from (
    select r.tenant_id, count(*)::bigint total,
      count(*) filter (where coalesce(r.processed, false))::bigint processed,
      count(*) filter (where not coalesce(r.processed, false))::bigint unprocessed,
      count(*) filter (where not coalesce(r.processed, false) and r.processed_at is not null)::bigint stuck,
      count(*) filter (where coalesce(r.processed, false) and r.processed_at >= now() - make_interval(hours => greatest(coalesce(p_hours, 24), 1)))::bigint processed_recent
    from public.raw_messages r
    where p_tenant_id is null or r.tenant_id = p_tenant_id
    group by r.tenant_id
  ) x left join public.organizations o on o.id = x.tenant_id
)
select jsonb_build_object(
  'total_raw_messages', raw.total, 'unprocessed', raw.unprocessed,
  'processed', greatest(raw.total - raw.unprocessed, 0), 'stuck', raw.stuck,
  'processed_recent', raw.processed_recent,
  'rate_window_hours', greatest(coalesce(p_hours, 24), 1),
  'extraction_cache_rows', cache.rows, 'ai_calls', usage.calls,
  'est_cost_usd', round(usage.cost, 6),
  'percent_drained', case when raw.total = 0 then 0 else round((raw.total - raw.unprocessed) * 100.0 / raw.total, 2) end,
  'tenant_breakdown', tenant_rows.value
)
from raw, usage, cache, tenant_rows;
$$;

revoke all on function public.get_extraction_progress(integer, uuid) from public;
grant execute on function public.get_extraction_progress(integer, uuid) to service_role;
