-- Enable the live extraction queue for incoming direct chats as well as
-- groups. History-sync rows remain processed/suppressed at ingestion, so
-- applying this migration does not backfill historical DMs.

drop index if exists public.idx_raw_messages_pending_tenant_timestamp_id;
create index if not exists idx_raw_messages_pending_tenant_timestamp_id
  on public.raw_messages (tenant_id, "timestamp", id)
  where processed = false and extraction_suppressed = false;

drop index if exists public.idx_raw_messages_pending_group_id;
create index if not exists idx_raw_messages_pending_group_id
  on public.raw_messages (id)
  where processed = false and extraction_suppressed = false;

drop index if exists public.idx_raw_messages_pending_group_timestamp_id;
create index if not exists idx_raw_messages_pending_group_timestamp_id
  on public.raw_messages ("timestamp", id)
  where processed = false and extraction_suppressed = false;

create or replace function public.get_workspace_extraction_progress(
  p_tenant_id uuid,
  p_hours integer default 24
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_total bigint;
  v_unprocessed bigint;
  v_suppressed bigint;
  v_stuck bigint;
  v_processed_recent bigint;
  v_cache_rows bigint;
  v_hours integer := greatest(coalesce(p_hours, 24), 1);
begin
  if p_tenant_id is null then
    raise exception 'tenant_id is required for workspace extraction progress';
  end if;

  perform set_config('statement_timeout', '60000', true);

  select count(*)::bigint,
    count(*) filter (where not coalesce(r.processed, false))::bigint,
    count(*) filter (where not coalesce(r.processed, false)
      and coalesce(r.extraction_suppressed, false))::bigint,
    count(*) filter (where not coalesce(r.processed, false) and r.processed_at is not null)::bigint,
    count(*) filter (where coalesce(r.processed, false)
      and r.processed_at >= now() - make_interval(hours => v_hours))::bigint
  into v_total, v_unprocessed, v_suppressed, v_stuck, v_processed_recent
  from public.raw_messages r
  where r.tenant_id = p_tenant_id;

  select count(*)::bigint into v_cache_rows
  from public.extraction_cache c
  where c.tenant_id = p_tenant_id;

  return jsonb_build_object(
    'total_raw_messages', v_total,
    'unprocessed', v_unprocessed,
    'pending', v_unprocessed,
    'suppressed', v_suppressed,
    'eligible_pending', greatest(v_unprocessed - v_suppressed, 0),
    'processed', greatest(v_total - v_unprocessed, 0),
    'stuck', v_stuck,
    'processed_recent', v_processed_recent,
    'rate_window_hours', v_hours,
    'extraction_cache_rows', v_cache_rows,
    'progress_pct', case when v_total = 0 then 0
      else round((v_total - v_unprocessed) * 100.0 / v_total, 2) end
  );
end;
$$;

revoke all on function public.get_workspace_extraction_progress(uuid, integer) from public;
grant execute on function public.get_workspace_extraction_progress(uuid, integer) to service_role;

create or replace function public.get_extraction_progress(
  p_hours integer default 24,
  p_tenant_id uuid default null
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_result jsonb;
begin
  perform set_config('statement_timeout', '60000', true);

  if p_tenant_id is not null then
    select jsonb_build_object(
      'total_raw_messages', count(*)::bigint,
      'unprocessed', count(*) filter (where not coalesce(r.processed, false))::bigint,
      'processed', count(*) filter (where coalesce(r.processed, false))::bigint,
      'stuck', count(*) filter (where not coalesce(r.processed, false) and r.processed_at is not null)::bigint,
      'processed_recent', count(*) filter (where coalesce(r.processed, false)
        and r.processed_at >= now() - make_interval(hours => greatest(coalesce(p_hours, 24), 1)))::bigint,
      'rate_window_hours', greatest(coalesce(p_hours, 24), 1),
      'extraction_cache_rows', (select count(*)::bigint from public.extraction_cache c where c.tenant_id = p_tenant_id),
      'ai_calls', (select count(*)::bigint from public.ai_usage_log u where u.agent = 'extraction' and u.tenant_id = p_tenant_id),
      'est_cost_usd', (select round(coalesce(sum(coalesce(u.cost_usd, 0)), 0), 6) from public.ai_usage_log u where u.agent = 'extraction' and u.tenant_id = p_tenant_id),
      'percent_drained', case when count(*) = 0 then 0
        else round(count(*) filter (where coalesce(r.processed, false)) * 100.0 / count(*), 2) end,
      'tenant_breakdown', '[]'::jsonb
    ) into v_result
    from public.raw_messages r
    where r.tenant_id = p_tenant_id;
    return v_result;
  end if;

  with raw as (
    select count(*)::bigint total,
      count(*) filter (where not coalesce(r.processed, false))::bigint unprocessed,
      count(*) filter (where not coalesce(r.processed, false) and r.processed_at is not null)::bigint stuck,
      count(*) filter (where coalesce(r.processed, false)
        and r.processed_at >= now() - make_interval(hours => greatest(coalesce(p_hours, 24), 1)))::bigint processed_recent
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
        count(*) filter (where coalesce(r.processed, false)
          and r.processed_at >= now() - make_interval(hours => greatest(coalesce(p_hours, 24), 1)))::bigint processed_recent
      from public.raw_messages r
      group by r.tenant_id
    ) x left join public.organizations o on o.id = x.tenant_id
  )
  select jsonb_build_object(
    'total_raw_messages', raw.total, 'unprocessed', raw.unprocessed,
    'processed', raw.total - raw.unprocessed, 'stuck', raw.stuck,
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
