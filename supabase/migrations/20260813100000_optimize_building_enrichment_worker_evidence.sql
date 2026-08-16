-- Keep the worker evidence RPC bounded by indexes instead of sorting the full
-- enrichment queue and history tables on every dashboard refresh.
create index if not exists building_enrichment_jobs_activity_idx
  on public.building_enrichment_jobs
  ((coalesce(completed_at, started_at, created_at)) desc nulls last);

create index if not exists building_enrichment_jobs_failed_activity_idx
  on public.building_enrichment_jobs
  ((coalesce(completed_at, started_at, created_at)) desc nulls last)
  where status = 'failed';

create index if not exists building_enrichment_jobs_completed_at_idx
  on public.building_enrichment_jobs (completed_at desc nulls last)
  where status = 'completed';

create index if not exists building_enrichment_history_created_at_idx
  on public.building_enrichment_history (created_at desc nulls last);
