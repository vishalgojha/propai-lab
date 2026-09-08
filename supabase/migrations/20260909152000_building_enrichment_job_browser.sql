create or replace function public.get_building_enrichment_job_browser(
  p_page integer default 1,
  p_page_size integer default 25,
  p_status text default null,
  p_provider text default null,
  p_query text default null
)
returns jsonb
language sql
stable
as $$
with bounds as (
  select greatest(1, least(coalesce(p_page, 1), 10000)) as page,
         greatest(1, least(coalesce(p_page_size, 25), 100)) as page_size,
         nullif(lower(trim(p_status)), '') as status_filter,
         nullif(lower(trim(p_provider)), '') as provider_filter,
         nullif(lower(trim(p_query)), '') as query_filter
), filtered as (
  select j.id, j.status, j.provider, j.priority, j.attempts, j.max_attempts,
         j.last_error, j.scheduled_after, j.started_at, j.completed_at, j.created_at,
         b.id as building_db_id, b.building_id as building_code, b.canonical_name,
         b.micro_market, b.address, b.pincode, b.google_place_id, b.geocode_source,
         b.enrichment_confidence, latest.action as latest_action,
         case when b.address is not null or b.google_place_id is not null
                   or b.micro_market is not null then 'recorded'
              when j.status = 'needs_review' or latest.action = 'needs_review' then 'needs_review'
              else 'not_recorded' end as evidence_status,
         coalesce(j.completed_at, j.started_at, j.created_at) as activity_at
  from public.building_enrichment_jobs j
  left join public.buildings b on b.id = j.building_id
  left join lateral (
    select h.action from public.building_enrichment_history h
    where h.job_id = j.id order by h.created_at desc, h.id desc limit 1
  ) latest on true
  cross join bounds
  where (bounds.status_filter is null or lower(j.status) = bounds.status_filter)
    and (bounds.provider_filter is null or lower(j.provider) = bounds.provider_filter)
    and (bounds.query_filter is null or lower(concat_ws(' ', b.canonical_name, b.building_id, b.micro_market, b.address, b.pincode)) like '%' || bounds.query_filter || '%')
), page_rows as (
  select filtered.* from filtered, bounds
  order by activity_at desc nulls last
  offset ((bounds.page - 1) * bounds.page_size)
  limit bounds.page_size
)
select jsonb_build_object(
  'page', (select page from bounds),
  'page_size', (select page_size from bounds),
  'total', (select count(*)::integer from filtered),
  'jobs', coalesce((select jsonb_agg(to_jsonb(page_rows) order by activity_at desc nulls last) from page_rows), '[]'::jsonb)
);
$$;

revoke all on function public.get_building_enrichment_job_browser(integer, integer, text, text, text) from public, anon, authenticated;
grant execute on function public.get_building_enrichment_job_browser(integer, integer, text, text, text) to service_role;
