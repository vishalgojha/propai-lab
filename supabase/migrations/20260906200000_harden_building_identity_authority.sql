-- Make verified Google building identity authoritative for future observations,
-- while removing only exact registry duplicates and obvious configuration junk.
-- Raw messages and typed listing facts are preserved.
begin;

create temporary table _google_building_dedup_map (
  loser_id bigint primary key,
  winner_id bigint not null
) on commit drop;

insert into _google_building_dedup_map (loser_id, winner_id)
select loser_id, winner_id
from (
  select loser.id as loser_id, winner.id as winner_id,
         row_number() over (partition by loser.id order by winner.id) as winner_rank
  from public.buildings loser
  join public.buildings winner
  on winner.id < loser.id
 and winner.tenant_id is not distinct from loser.tenant_id
 and winner.google_place_id = loser.google_place_id
 and winner.google_place_id is not null
 and winner.geocode_source = 'google_places_text_search'
 and loser.geocode_source = 'google_places_text_search'
 and coalesce(winner.geocode_confidence, 0) >= 0.9
   and coalesce(loser.geocode_confidence, 0) >= 0.9
) ranked
where winner_rank = 1;

do $$
declare
  duplicate record;
  table_name text;
begin
  for duplicate in select loser_id, winner_id from _google_building_dedup_map loop
    foreach table_name in array array[
      'residential_sale_listings', 'residential_rent_listings',
      'commercial_sale_listings', 'commercial_rent_listings',
      'residential_sale_requirements', 'residential_rent_requirements',
      'commercial_sale_requirements', 'commercial_rent_requirements',
      'developer_projects', 'resolver_decisions'
    ] loop
      execute format('update public.%I set building_id = $1 where building_id = $2', table_name)
        using duplicate.winner_id, duplicate.loser_id;
    end loop;

    delete from public.building_name_aliases loser_alias
    where loser_alias.building_id = duplicate.loser_id
      and exists (
        select 1 from public.building_name_aliases winner_alias
        where winner_alias.building_id = duplicate.winner_id
          and lower(trim(winner_alias.alias)) = lower(trim(loser_alias.alias))
      );
    update public.building_name_aliases
       set building_id = duplicate.winner_id
     where building_id = duplicate.loser_id;

    delete from public.building_enrichment_jobs loser_job
    where loser_job.building_id = duplicate.loser_id
      and exists (
        select 1 from public.building_enrichment_jobs winner_job
        where winner_job.building_id = duplicate.winner_id
          and winner_job.provider = loser_job.provider
      );
    update public.building_enrichment_jobs
       set building_id = duplicate.winner_id
     where building_id = duplicate.loser_id;

    delete from public.building_enrichment_sources loser_source
    where loser_source.building_id = duplicate.loser_id
      and exists (
        select 1 from public.building_enrichment_sources winner_source
        where winner_source.building_id = duplicate.winner_id
          and winner_source.provider = loser_source.provider
          and winner_source.field_name = loser_source.field_name
      );
    update public.building_enrichment_sources
       set building_id = duplicate.winner_id
     where building_id = duplicate.loser_id;
    update public.building_enrichment_history
       set building_id = duplicate.winner_id
     where building_id = duplicate.loser_id;

    delete from public.buildings where id = duplicate.loser_id;
  end loop;
end $$;

-- These are extraction labels, not physical buildings. Quarantine rather than
-- delete so any historical links remain auditable and recoverable.
update public.buildings
   set status = 'quarantined', updated_at = now()
 where lower(trim(canonical_name)) in ('config', 'configuration', 'configuration type');

commit;
