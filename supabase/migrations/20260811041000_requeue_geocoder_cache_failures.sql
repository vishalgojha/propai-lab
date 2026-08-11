-- The previous geocoder deployment failed before making a provider request
-- because GooglePlacesProvider's cache-key override had the old signature.
-- Retry only that exact failure class after the worker hotfix is deployed.
update public.building_enrichment_jobs
   set status = 'pending',
       attempts = 0,
       last_error = null,
       started_at = null,
       completed_at = null,
       scheduled_after = now()
 where status = 'failed'
   and last_error like '%GooglePlacesProvider._get_cache_key() takes 2 positional arguments but 3 were given%';

insert into public.data_quality_backfill_runs(run_name, details)
select 'requeue_geocoder_cache_key_failures', jsonb_build_object(
  'requeued_jobs', count(*)
)
from public.building_enrichment_jobs
where status = 'pending'
  and scheduled_after >= now() - interval '1 minute';
