-- Requeue only failures with a known code-level remediation.  Identity
-- mismatches remain terminal for review; retrying them cannot create evidence.
do $$
declare
  repaired integer;
begin
  with repairable as (
    select j.id,
           row_number() over (
             partition by j.building_id, j.provider
             order by j.id desc
           ) as duplicate_rank
      from public.building_enrichment_jobs j
     where j.status = 'failed'
       and (
         j.last_error like '%residential_sale_listings?select=locality_raw%monthly_rent%total_asking_price%'
         or j.last_error like '%GooglePlacesProvider._get_cache_key() takes 2 positional arguments but 3 were given%'
         or j.last_error like '%<urlopen error [Errno 104] Connection reset by peer>%'
       )
       and not exists (
         select 1
           from public.building_enrichment_jobs active
          where active.building_id = j.building_id
            and active.provider = j.provider
            and active.status in ('pending', 'running')
       )
  )
  update public.building_enrichment_jobs j
     set status = 'pending',
         attempts = 0,
         last_error = null,
         started_at = null,
         completed_at = null,
         scheduled_after = now()
    from repairable r
   where j.id = r.id
     and r.duplicate_rank = 1;

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
