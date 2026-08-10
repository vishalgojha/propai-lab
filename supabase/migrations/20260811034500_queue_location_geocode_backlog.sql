-- Requeue the existing building-enrichment pipeline for missing and suspect
-- coordinates.  This does not create a second geocoder or discard old data.

insert into public.building_enrichment_jobs(
  building_id, status, provider, priority, max_attempts
)
select b.id,
       'pending',
       'unassigned',
       case when b.latitude is not null and
                 (b.latitude < 18.8 or b.latitude > 19.3 or
                  b.longitude < 72.7 or b.longitude > 73.2)
            then 100 else 25 end,
       3
  from public.buildings b
 where (b.geocode_source is null
    or (b.latitude is not null and
        (b.latitude < 18.8 or b.latitude > 19.3 or
         b.longitude < 72.7 or b.longitude > 73.2)))
   and not exists (
     select 1
       from public.building_enrichment_jobs j
      where j.building_id = b.id
        and j.status in ('pending', 'running')
   );

create table if not exists public.data_quality_backfill_runs (
  id bigint generated always as identity primary key,
  run_name text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);

insert into public.data_quality_backfill_runs(run_name, details)
select 'building_geocode_backlog_requeued', jsonb_build_object(
  'target_ungeocoded', (select count(*) from public.buildings where geocode_source is null),
  'target_out_of_bounds', (select count(*) from public.buildings where latitude is not null and
    (latitude < 18.8 or latitude > 19.3 or longitude < 72.7 or longitude > 73.2)),
  'pending_after_enqueue', (select count(*) from public.building_enrichment_jobs where status = 'pending')
);
