-- Keep broker-facing dashboards independent from AI-usage/cache telemetry.
-- These are exact counts over the tenant's raw ledger, not estimates.
create or replace function public.get_workspace_extraction_progress(
  p_tenant_id uuid,
  p_hours integer default 24
)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_total bigint;
  v_unprocessed bigint;
  v_stuck bigint;
  v_processed_recent bigint;
  v_hours integer := greatest(coalesce(p_hours, 24), 1);
begin
  if p_tenant_id is null then
    raise exception 'tenant_id is required for workspace extraction progress';
  end if;

  select count(*)::bigint,
    count(*) filter (where not coalesce(r.processed, false))::bigint,
    count(*) filter (where not coalesce(r.processed, false) and r.processed_at is not null)::bigint,
    count(*) filter (where coalesce(r.processed, false)
      and r.processed_at >= now() - make_interval(hours => v_hours))::bigint
  into v_total, v_unprocessed, v_stuck, v_processed_recent
  from public.raw_messages r
  where r.tenant_id = p_tenant_id;

  return jsonb_build_object(
    'total_raw_messages', v_total,
    'unprocessed', v_unprocessed,
    'processed', greatest(v_total - v_unprocessed, 0),
    'stuck', v_stuck,
    'processed_recent', v_processed_recent,
    'rate_window_hours', v_hours
  );
end;
$$;

revoke all on function public.get_workspace_extraction_progress(uuid, integer) from public;
grant execute on function public.get_workspace_extraction_progress(uuid, integer) to service_role;
