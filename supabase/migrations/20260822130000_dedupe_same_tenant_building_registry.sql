-- Idempotently remove only exact registry duplicates: same tenant, same
-- normalized name, and same locality. Same names in another locality or
-- tenant are intentionally preserved.
do $$
declare
  duplicate record;
  table_name text;
begin
  create temporary table building_dedup_map on commit drop as
  with ranked as (
    select b.id,
      first_value(b.id) over (
        partition by b.tenant_id, lower(trim(b.canonical_name)),
          coalesce(b.canonical_micro_market_slug, nullif(trim(both '-' from regexp_replace(lower(coalesce(b.micro_market, '')), '[^a-z0-9]+', '-', 'g')), ''))
        order by (b.canonical_micro_market_slug is not null) desc,
          coalesce(b.observed_listings, 0) desc, b.created_at, b.id
      ) as survivor_id,
      count(*) over (
        partition by b.tenant_id, lower(trim(b.canonical_name)),
          coalesce(b.canonical_micro_market_slug, nullif(trim(both '-' from regexp_replace(lower(coalesce(b.micro_market, '')), '[^a-z0-9]+', '-', 'g')), ''))
      ) as duplicate_count
    from public.buildings b
    where nullif(trim(b.canonical_name), '') is not null
  )
  select id as loser_id, survivor_id
  from ranked
  where duplicate_count > 1 and id <> survivor_id;

  for duplicate in select loser_id, survivor_id from building_dedup_map loop
    foreach table_name in array array[
      'residential_sale_listings', 'residential_rent_listings',
      'commercial_sale_listings', 'commercial_rent_listings',
      'residential_sale_requirements', 'residential_rent_requirements',
      'commercial_sale_requirements', 'commercial_rent_requirements'
    ] loop
      execute format(
        'update public.%I set building_id = $1 where building_id = $2',
        table_name
      ) using duplicate.survivor_id, duplicate.loser_id;
    end loop;

    -- Aliases are unique globally. Keep the survivor's copy when an alias
    -- exists on both rows; otherwise move the alias to the survivor.
    delete from public.building_name_aliases loser_alias
    where loser_alias.building_id = duplicate.loser_id
      and exists (
        select 1 from public.building_name_aliases survivor_alias
        where survivor_alias.building_id = duplicate.survivor_id
          and lower(trim(survivor_alias.alias)) = lower(trim(loser_alias.alias))
      );
    update public.building_name_aliases
    set building_id = duplicate.survivor_id
    where building_id = duplicate.loser_id;

    -- Enrichment artifacts are derived data. Preserve history, and discard
    -- only conflicting current jobs/sources before moving them.
    delete from public.building_enrichment_jobs loser_job
    where loser_job.building_id = duplicate.loser_id
      and exists (
        select 1 from public.building_enrichment_jobs survivor_job
        where survivor_job.building_id = duplicate.survivor_id
          and survivor_job.provider = loser_job.provider
      );
    update public.building_enrichment_jobs
    set building_id = duplicate.survivor_id
    where building_id = duplicate.loser_id;

    delete from public.building_enrichment_sources loser_source
    where loser_source.building_id = duplicate.loser_id
      and exists (
        select 1 from public.building_enrichment_sources survivor_source
        where survivor_source.building_id = duplicate.survivor_id
          and survivor_source.provider = loser_source.provider
      );
    update public.building_enrichment_sources
    set building_id = duplicate.survivor_id
    where building_id = duplicate.loser_id;
    update public.building_enrichment_history
    set building_id = duplicate.survivor_id
    where building_id = duplicate.loser_id;

    delete from public.buildings where id = duplicate.loser_id;
  end loop;

  -- Make the locality key available for every registry row before enforcing
  -- uniqueness. Future retries then resolve to the same registry row.
  update public.buildings
  set canonical_micro_market_slug = nullif(
    trim(both '-' from regexp_replace(lower(coalesce(micro_market, '')), '[^a-z0-9]+', '-', 'g')),
    ''
  )
  where canonical_micro_market_slug is null and micro_market is not null;
end $$;

create unique index if not exists uq_buildings_tenant_name_locality
on public.buildings (
  coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
  lower(trim(canonical_name)),
  coalesce(canonical_micro_market_slug, '')
);
