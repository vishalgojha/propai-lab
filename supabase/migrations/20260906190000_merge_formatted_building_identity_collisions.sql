-- Clean the eight building-registry rows that remained wrapped in WhatsApp
-- formatting. Merge only rows with the same Google place identity; preserve
-- distinct records that merely share a name/locality.
begin;

create temporary table _formatted_building_identity_map (
  loser_id bigint primary key,
  winner_id bigint not null
) on commit drop;

insert into _formatted_building_identity_map (loser_id, winner_id)
select loser.id, winner.id
from public.buildings loser
join public.buildings winner
  on winner.tenant_id is not distinct from loser.tenant_id
 and winner.canonical_micro_market_slug is not distinct from loser.canonical_micro_market_slug
 and lower(winner.canonical_name) = lower(btrim(loser.canonical_name, chr(42)))
 and winner.id <> loser.id
 and winner.google_place_id is not null
 and winner.google_place_id = loser.google_place_id
where loser.id in (11653, 12255, 12498, 12817, 17060, 17797, 17911);

-- Remove only enrichment-source duplicates made redundant by an exact place
-- identity match, preserving the already-canonical winner's source rows.
delete from public.building_enrichment_sources loser_source
using _formatted_building_identity_map map
where loser_source.building_id = map.loser_id
  and exists (
    select 1
    from public.building_enrichment_sources winner_source
    where winner_source.building_id = map.winner_id
      and winner_source.provider = loser_source.provider
      and winner_source.field_name = loser_source.field_name
  );

do $do$
declare
  table_name text;
begin
  foreach table_name in array array[
    'building_enrichment_history',
    'building_enrichment_jobs',
    'building_enrichment_sources',
    'commercial_rent_listings',
    'commercial_rent_requirements',
    'commercial_sale_listings',
    'commercial_sale_requirements',
    'developer_projects',
    'residential_rent_listings',
    'residential_rent_requirements',
    'residential_sale_listings',
    'residential_sale_requirements',
    'resolver_decisions'
  ]
  loop
    execute format(
      'update public.%I target
          set building_id = map.winner_id
        from _formatted_building_identity_map map
       where target.building_id = map.loser_id',
      table_name
    );
  end loop;
end
$do$;

update public.building_name_aliases aliases
   set building_id = map.winner_id
  from _formatted_building_identity_map map
 where aliases.building_id = map.loser_id;

delete from public.buildings buildings
using _formatted_building_identity_map map
where buildings.id = map.loser_id;

-- These two rows have different source coordinates, so keep both identities
-- and make the display names unique using the first source-address segment.
update public.buildings
set canonical_name = nullif(btrim(regexp_replace(regexp_replace(btrim(canonical_name), '\s+', ' ', 'g'), '^[*_~`]+|[*_~`]+$', '', 'g')), '')
                 || ' · ' || nullif(btrim(split_part(address, ',', 1)), ''),
    updated_at = now()
where id in (8930, 11653);

update public.building_name_aliases
set alias = nullif(btrim(regexp_replace(regexp_replace(btrim(alias), '\s+', ' ', 'g'), '^[*_~`]+|[*_~`]+$', '', 'g')), ''),
    canonical_name = nullif(btrim(regexp_replace(regexp_replace(btrim(canonical_name), '\s+', ' ', 'g'), '^[*_~`]+|[*_~`]+$', '', 'g')), '')
where building_id in (8930, 11653)
  and (alias ~ '(^[*_~`]+|[*_~`]+$)' or canonical_name ~ '(^[*_~`]+|[*_~`]+$)');

commit;
