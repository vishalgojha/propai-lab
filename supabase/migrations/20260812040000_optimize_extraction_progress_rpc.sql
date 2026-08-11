-- Keep workspace progress fast on large raw_messages tables.
-- Tenant dashboards do not need the global tenant breakdown; calculating it
-- caused a second full aggregate scan and made the RPC time out in production.
create or replace function public.get_extraction_progress(
  p_hours integer default 24,
  p_tenant_id uuid default null
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_total bigint;
  v_unprocessed bigint;
  v_stuck bigint;
  v_processed_recent bigint;
  v_calls bigint;
  v_cost numeric;
  v_cache_rows bigint;
  v_result jsonb;
begin
  if p_tenant_id is not null then
    select count(*)::bigint,
      count(*) filter (where not coalesce(r.processed, false))::bigint,
      count(*) filter (where not coalesce(r.processed, false) and r.processed_at is not null)::bigint,
      count(*) filter (where coalesce(r.processed, false)
        and r.processed_at >= now() - make_interval(hours => greatest(coalesce(p_hours, 24), 1)))::bigint
    into v_total, v_unprocessed, v_stuck, v_processed_recent
    from public.raw_messages r
    where r.tenant_id = p_tenant_id;

    select count(*)::bigint, coalesce(sum(coalesce(u.cost_usd, 0)), 0)::numeric
      into v_calls, v_cost
    from public.ai_usage_log u
    where u.agent = 'extraction' and u.tenant_id = p_tenant_id;

    select count(*)::bigint into v_cache_rows
    from public.extraction_cache c
    where c.tenant_id = p_tenant_id;

    return jsonb_build_object(
      'total_raw_messages', v_total,
      'unprocessed', v_unprocessed,
      'processed', greatest(v_total - v_unprocessed, 0),
      'stuck', v_stuck,
      'processed_recent', v_processed_recent,
      'rate_window_hours', greatest(coalesce(p_hours, 24), 1),
      'extraction_cache_rows', v_cache_rows,
      'ai_calls', v_calls,
      'est_cost_usd', round(v_cost, 6),
      'percent_drained', case when v_total = 0 then 0
        else round((v_total - v_unprocessed) * 100.0 / v_total, 2) end,
      'tenant_breakdown', '[]'::jsonb
    );
  end if;

  with raw as (
    select count(*)::bigint total,
      count(*) filter (where not coalesce(r.processed, false))::bigint unprocessed,
      count(*) filter (where not coalesce(r.processed, false) and r.processed_at is not null)::bigint stuck,
      count(*) filter (where coalesce(r.processed, false) and r.processed_at >= now() - make_interval(hours => greatest(coalesce(p_hours, 24), 1)))::bigint processed_recent
    from public.raw_messages r
  ), usage as (
    select count(*)::bigint calls, coalesce(sum(coalesce(u.cost_usd, 0)), 0)::numeric cost
    from public.ai_usage_log u where u.agent = 'extraction'
  ), cache as (
    select count(*)::bigint rows from public.extraction_cache
  ), tenant_rows as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'tenant_id', x.tenant_id, 'organization_name', coalesce(o.name, x.tenant_id::text),
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
      from public.raw_messages r group by r.tenant_id
    ) x left join public.organizations o on o.id = x.tenant_id
  )
  select jsonb_build_object(
    'total_raw_messages', raw.total, 'unprocessed', raw.unprocessed,
    'processed', greatest(raw.total - raw.unprocessed, 0), 'stuck', raw.stuck,
    'processed_recent', raw.processed_recent,
    'rate_window_hours', greatest(coalesce(p_hours, 24), 1),
    'extraction_cache_rows', cache.rows, 'ai_calls', usage.calls,
    'est_cost_usd', round(usage.cost, 6),
    'percent_drained', case when raw.total = 0 then 0
      else round((raw.total - raw.unprocessed) * 100.0 / raw.total, 2) end,
    'tenant_breakdown', tenant_rows.value
  ) into v_result
  from raw, usage, cache, tenant_rows;
  return v_result;
end;
$$;

revoke all on function public.get_extraction_progress(integer, uuid) from public;
grant execute on function public.get_extraction_progress(integer, uuid) to service_role;
