-- Cost-aware read-only metrics for the extraction boundary. The estimate uses
-- the observed mean extraction call cost; it does not invent a provider rate.
create or replace function public.get_dedupe_cost_metrics()
returns table (
  shared_reuses bigint,
  pre_llm_messages_skipped bigint,
  protocol_events_filtered bigint,
  model_calls_avoided bigint,
  observed_extraction_calls bigint,
  observed_extraction_cost_usd numeric,
  observed_mean_extraction_cost_usd numeric,
  estimated_cost_avoided_usd numeric
)
language sql
security definer
set search_path = public
stable
as $fn$
  with shared as (
    select count(*) filter (where outcome = 'reused')::bigint as reuses
    from public.shared_extraction_observations
  ), raw as (
    select
      count(*) filter (where extraction_outcome like 'pre_llm:%')::bigint as pre_llm,
      count(*) filter (where extraction_outcome = 'protocol_event')::bigint as protocols
    from public.raw_messages
    where processed = true
  ), usage as (
    select
      count(*)::bigint as calls,
      coalesce(sum(coalesce(cost_usd, 0)), 0)::numeric as cost
    from public.ai_usage_log
    where agent = 'extraction'
  ), totals as (
    select
      shared.reuses,
      raw.pre_llm,
      raw.protocols,
      usage.calls,
      usage.cost,
      case when usage.calls = 0 then 0 else usage.cost / usage.calls end as mean_cost
    from shared cross join raw cross join usage
  )
  select
    reuses,
    pre_llm,
    protocols,
    (reuses + pre_llm)::bigint,
    calls,
    round(cost, 6),
    round(mean_cost, 6),
    round((reuses + pre_llm) * mean_cost, 6)
  from totals;
$fn$;

revoke all on function public.get_dedupe_cost_metrics() from public, anon, authenticated;
grant execute on function public.get_dedupe_cost_metrics() to service_role;
