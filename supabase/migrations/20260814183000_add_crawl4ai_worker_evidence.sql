-- Expose durable, source-backed evidence for the web-first building enrichment
-- stage. This is deliberately history-based: a heartbeat alone cannot prove
-- that search, verification, or alias application is working.
create or replace function public.get_building_enrichment_worker_evidence()
returns jsonb
language sql
stable
as $$
with job_counts as (
  select
    count(*) filter (where status = 'pending')::integer as pending,
    count(*) filter (where status = 'running')::integer as running,
    count(*) filter (where status = 'completed')::integer as completed,
    count(*) filter (where status = 'failed')::integer as failed,
    count(*)::integer as total
  from public.building_enrichment_jobs
),
recent_jobs as (
  select coalesce(jsonb_agg(to_jsonb(x) order by x.activity_at desc), '[]'::jsonb) as value
  from (
    select j.id, j.status, j.provider, j.priority, j.attempts, j.max_attempts,
           j.last_error, j.scheduled_after, j.started_at, j.completed_at,
           j.created_at, b.id as building_db_id, b.building_id as building_code,
           b.canonical_name, b.micro_market,
           coalesce(j.completed_at, j.started_at, j.created_at) as activity_at
    from public.building_enrichment_jobs j
    left join public.buildings b on b.id = j.building_id
    order by coalesce(j.completed_at, j.started_at, j.created_at) desc nulls last
    limit 30
  ) x
),
recent_history as (
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb) as value
  from (
    select h.id, h.job_id, h.provider, h.action, h.fields_updated,
           h.confidence, h.details, h.created_at,
           b.building_id as building_code, b.canonical_name, b.micro_market
    from public.building_enrichment_history h
    left join public.buildings b on b.id = h.building_id
    order by h.created_at desc
    limit 30
  ) x
),
web_today as (
  select
    count(*) filter (where action = 'web_search_attempt')::integer as attempts,
    count(*) filter (where action = 'alias_discovered')::integer as corrections,
    count(*) filter (where action in ('failed', 'retry_scheduled'))::integer as failures,
    count(*) filter (where action = 'web_search_budget_exhausted')::integer as budget_exhausted
  from public.building_enrichment_history
  where provider = 'crawl4ai'
    and created_at >= date_trunc('day', now() at time zone 'utc') at time zone 'utc'
),
recent_web_evidence as (
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc), '[]'::jsonb) as value
  from (
    select h.id, h.job_id, h.action, h.confidence, h.details, h.created_at,
           b.building_id as building_code, b.canonical_name, b.micro_market
    from public.building_enrichment_history h
    left join public.buildings b on b.id = h.building_id
    where h.provider = 'crawl4ai'
    order by h.created_at desc
    limit 40
  ) x
),
latest_success as (
  select max(completed_at) filter (where status = 'completed') as completed_at
  from public.building_enrichment_jobs
),
latest_failure as (
  select jsonb_build_object(
    'id', j.id, 'status', j.status, 'provider', j.provider,
    'last_error', j.last_error, 'attempts', j.attempts,
    'updated_at', coalesce(j.completed_at, j.started_at, j.created_at),
    'building_code', b.building_id, 'canonical_name', b.canonical_name
  ) as value
  from public.building_enrichment_jobs j
  left join public.buildings b on b.id = j.building_id
  where j.status = 'failed'
  order by coalesce(j.completed_at, j.started_at, j.created_at) desc nulls last
  limit 1
)
select jsonb_build_object(
  'worker', coalesce(
    (select to_jsonb(h) from public.worker_heartbeats h
     where h.worker_name = 'building-enrichment-worker'),
    jsonb_build_object(
      'worker_name', 'building-enrichment-worker',
      'service_name', 'building-enrichment-worker',
      'status', 'unknown', 'heartbeat_at', null
    )
  ),
  'queue', (select to_jsonb(job_counts) from job_counts),
  'latest_success_at', (select completed_at from latest_success),
  'latest_failure', coalesce((select value from latest_failure), 'null'::jsonb),
  'recent_jobs', (select value from recent_jobs),
  'recent_history', (select value from recent_history),
  'web_search', (select to_jsonb(web_today) from web_today),
  'recent_web_evidence', (select value from recent_web_evidence)
);
$$;

revoke all on function public.get_building_enrichment_worker_evidence() from public, anon, authenticated;
grant execute on function public.get_building_enrichment_worker_evidence() to service_role;
