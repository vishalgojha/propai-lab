-- Restore locality data that was incorrectly captured in building_name.
-- The helper is retained so future controlled repairs can use the same
-- locality_reference/location_aliases matching rules.

create or replace function public.backfill_listing_locality_from_building_name(
  p_table regclass
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_rows bigint;
begin
  execute format($sql$
    with locality_names as (
      select nullif(btrim(sub_locality), '') as raw_mention,
             nullif(btrim(parent_locality), '') as resolved_locality
        from public.locality_reference
       where nullif(btrim(sub_locality), '') is not null
      union all
      select nullif(btrim(alias_name), ''),
             nullif(btrim(parent_locality), '')
        from public.locality_reference lr
        cross join lateral unnest(coalesce(lr.alternate_names, array[]::text[])) as a(alias_name)
       where nullif(btrim(alias_name), '') is not null
      union all
      select nullif(btrim(alias), ''), nullif(btrim(canonical), '')
        from public.location_aliases
       where nullif(btrim(alias), '') is not null
    ), candidates as (
      select l.id, match.raw_mention, match.resolved_locality
        from %s l
        cross join lateral (
          select n.raw_mention, n.resolved_locality
            from locality_names n
           where nullif(btrim(l.building_name), '') is not null
             and l.building_name ilike '%%' || n.raw_mention || '%%'
           order by length(n.raw_mention) desc, n.raw_mention
           limit 1
        ) match
       where nullif(btrim(l.micro_market), '') is null
    )
    update %s l
       set locality_raw = coalesce(nullif(btrim(l.locality_raw), ''), c.raw_mention),
           locality_resolved = coalesce(nullif(btrim(l.locality_resolved), ''), c.resolved_locality),
           micro_market = coalesce(nullif(btrim(l.micro_market), ''), c.resolved_locality)
      from candidates c
     where l.id = c.id
  $sql$, p_table, p_table);
  get diagnostics updated_rows = row_count;
  return updated_rows;
end;
$$;

do $$
declare
  sale_residential bigint;
  rent_residential bigint;
  sale_commercial bigint;
  rent_commercial bigint;
begin
  sale_residential := public.backfill_listing_locality_from_building_name('public.residential_sale_listings'::regclass);
  rent_residential := public.backfill_listing_locality_from_building_name('public.residential_rent_listings'::regclass);
  sale_commercial := public.backfill_listing_locality_from_building_name('public.commercial_sale_listings'::regclass);
  rent_commercial := public.backfill_listing_locality_from_building_name('public.commercial_rent_listings'::regclass);

  create table if not exists public.data_quality_backfill_runs (
    id bigint generated always as identity primary key,
    run_name text not null,
    details jsonb not null default '{}',
    created_at timestamptz not null default now()
  );

  insert into public.data_quality_backfill_runs(run_name, details)
  values (
    'listing_locality_from_building_name',
    jsonb_build_object(
      'residential_sale_updated', sale_residential,
      'residential_rent_updated', rent_residential,
      'commercial_sale_updated', sale_commercial,
      'commercial_rent_updated', rent_commercial,
      'total_updated', sale_residential + rent_residential + sale_commercial + rent_commercial
    )
  );
end;
$$;

-- The enrichment worker orders pending jobs by priority. Promote the 500 most
-- observed buildings so a supported worker deployment processes useful map
-- coverage first, without creating duplicate jobs or changing job ownership.
with top_buildings as (
  select j.id
    from public.building_enrichment_jobs j
    join public.buildings b on b.id = j.building_id
   where j.status = 'pending'
   order by coalesce(b.observed_listings, 0) desc, b.id
   limit 500
)
update public.building_enrichment_jobs j
   set priority = greatest(coalesce(j.priority, 0), 100)
 where j.id in (select id from top_buildings);

insert into public.data_quality_backfill_runs(run_name, details)
select 'building_geocoding_priority_queue', jsonb_build_object(
  'promoted_jobs', count(*) filter (where priority >= 100),
  'pending_jobs', count(*) filter (where status = 'pending')
)
from public.building_enrichment_jobs;
