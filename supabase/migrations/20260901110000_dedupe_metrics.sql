-- Read-only operational metrics for the pre-LLM dedupe boundary.
-- Counts are raw-message/observation counts, not claims about semantic merges.

create or replace function public.get_dedupe_metrics()
returns table (
  shared_results bigint,
  shared_origins bigint,
  shared_reuses bigint,
  shared_reuse_rate numeric,
  model_calls_avoided bigint,
  protocol_events_filtered bigint,
  pre_llm_messages_skipped bigint
)
language sql
security definer
set search_path = public
stable
as $fn$
  with shared as (
    select
      count(*) filter (where outcome = 'origin')::bigint as origins,
      count(*) filter (where outcome = 'reused')::bigint as reuses
    from public.shared_extraction_observations
  ),
  raw as (
    select
      count(*) filter (where extraction_outcome = 'protocol_event')::bigint as protocols,
      count(*) filter (where extraction_outcome like 'pre_llm:%')::bigint as pre_llm
    from public.raw_messages
    where processed = true
  )
  select
    (select count(*)::bigint from public.shared_extraction_results),
    shared.origins,
    shared.reuses,
    case when shared.origins + shared.reuses = 0 then 0
      else round(shared.reuses::numeric / (shared.origins + shared.reuses), 4)
    end,
    shared.reuses,
    raw.protocols,
    raw.pre_llm
  from shared cross join raw;
$fn$;

revoke all on function public.get_dedupe_metrics() from public, anon, authenticated;
grant execute on function public.get_dedupe_metrics() to service_role;
