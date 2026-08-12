-- Requeue only failures with a known code-level remediation.  Identity
-- mismatches remain terminal for review; retrying them cannot create evidence.
do $$
declare
  repaired integer;
begin
  update public.building_enrichment_jobs
     set status = 'pending',
         attempts = 0,
         last_error = null,
         started_at = null,
         completed_at = null,
         scheduled_after = now()
   where status = 'failed'
     and (
       last_error like '%residential_sale_listings?select=locality_raw%monthly_rent%total_asking_price%'
       or last_error like '%GooglePlacesProvider._get_cache_key() takes 2 positional arguments but 3 were given%'
       or last_error like '%<urlopen error [Errno 104] Connection reset by peer>%'
     );

  get diagnostics repaired = row_count;

  insert into public.data_quality_backfill_runs(run_name, details)
  values (
    'repair_building_enrichment_failures',
    jsonb_build_object(
      'requeued_jobs', repaired,
      'reason', 'schema-specific evidence projections, cache-key signature, and transient connection failures'
    )
  );
end $$;
