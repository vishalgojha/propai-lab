-- Materialize locality that older writers left inside ai_extraction JSON.

do $$
declare
  t text;
begin
  foreach t in array array[
    'residential_sale_listings', 'residential_rent_listings',
    'commercial_sale_listings', 'commercial_rent_listings'
  ] loop
    execute format($sql$
      update public.%I l
         set locality_raw = coalesce(nullif(btrim(l.locality_raw), ''), nullif(btrim(l.ai_extraction #>> '{locality,raw_mention}'), '')),
             locality_resolved = coalesce(
               nullif(btrim(l.locality_resolved), ''),
               nullif(btrim(l.ai_extraction #>> '{locality,resolved_locality}'), ''),
               (select lr.parent_locality
                  from public.locality_reference lr
                 where lower(lr.sub_locality) = lower(nullif(btrim(l.ai_extraction #>> '{locality,raw_mention}'), ''))
                 limit 1)
               , nullif(btrim(l.ai_extraction #>> '{locality,raw_mention}'), '')
             ),
             micro_market = coalesce(
               nullif(btrim(l.micro_market), ''),
               nullif(btrim(l.ai_extraction #>> '{locality,resolved_locality}'), ''),
               (select lr.parent_locality
                  from public.locality_reference lr
                 where lower(lr.sub_locality) = lower(nullif(btrim(l.ai_extraction #>> '{locality,raw_mention}'), ''))
                 limit 1)
               , nullif(btrim(l.ai_extraction #>> '{locality,raw_mention}'), '')
             )
       where nullif(btrim(l.micro_market), '') is null
         and nullif(btrim(l.ai_extraction #>> '{locality,raw_mention}'), '') is not null
    $sql$, t);
  end loop;
end;
$$;

create table if not exists public.data_quality_backfill_runs (
  id bigint generated always as identity primary key,
  run_name text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);

insert into public.data_quality_backfill_runs(run_name, details)
select 'listing_locality_from_ai_extraction', jsonb_build_object(
  'rows_with_materialized_locality', (
    select count(*) from public.listings_unified
     where nullif(btrim(locality_raw), '') is not null
        or nullif(btrim(locality_resolved), '') is not null
  )
);
