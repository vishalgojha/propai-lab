-- The legacy broker graph read parsed_output, which was removed during the
-- typed-table cutover. Rebuild directory aggregates from the eight typed
-- listing/requirement tables instead.

create or replace function public.rebuild_broker_graph()
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
    total_brokers integer := 0;
    total_observations integer := 0;
begin
    create temp table _typed_broker_source on commit drop as
    select id as record_id, tenant_id, broker_name, broker_phone, group_name,
           micro_market, building_name, created_at, updated_at, 'listing'::text as role
      from residential_sale_listings
     where coalesce(nullif(btrim(broker_name), ''), nullif(btrim(broker_phone), '')) is not null
    union all select id, tenant_id, broker_name, broker_phone, group_name, micro_market, building_name, created_at, updated_at, 'listing'
      from residential_rent_listings
     where coalesce(nullif(btrim(broker_name), ''), nullif(btrim(broker_phone), '')) is not null
    union all select id, tenant_id, broker_name, broker_phone, group_name, micro_market, building_name, created_at, updated_at, 'listing'
      from commercial_sale_listings
     where coalesce(nullif(btrim(broker_name), ''), nullif(btrim(broker_phone), '')) is not null
    union all select id, tenant_id, broker_name, broker_phone, group_name, micro_market, building_name, created_at, updated_at, 'listing'
      from commercial_rent_listings
     where coalesce(nullif(btrim(broker_name), ''), nullif(btrim(broker_phone), '')) is not null
    union all select id, tenant_id, broker_name, broker_phone, group_name, micro_market, building_name, created_at, updated_at, 'requirement'
      from residential_sale_requirements
     where coalesce(nullif(btrim(broker_name), ''), nullif(btrim(broker_phone), '')) is not null
    union all select id, tenant_id, broker_name, broker_phone, group_name, micro_market, building_name, created_at, updated_at, 'requirement'
      from residential_rent_requirements
     where coalesce(nullif(btrim(broker_name), ''), nullif(btrim(broker_phone), '')) is not null
    union all select id, tenant_id, broker_name, broker_phone, group_name, micro_market, building_name, created_at, updated_at, 'requirement'
      from commercial_sale_requirements
     where coalesce(nullif(btrim(broker_name), ''), nullif(btrim(broker_phone), '')) is not null
    union all select id, tenant_id, broker_name, broker_phone, group_name, micro_market, building_name, created_at, updated_at, 'requirement'
      from commercial_rent_requirements
    where coalesce(nullif(btrim(broker_name), ''), nullif(btrim(broker_phone), '')) is not null;

    alter table _typed_broker_source add column broker_key text;
    update _typed_broker_source
       set broker_key = public.broker_identity_key(broker_name, broker_phone);
    create index _typed_broker_source_key_idx on _typed_broker_source (broker_key);
    create index _typed_broker_source_market_idx on _typed_broker_source (broker_key, micro_market);
    create index _typed_broker_source_building_idx on _typed_broker_source (broker_key, building_name);
    create temp table _typed_broker_ids on commit drop as
    select distinct broker_id from residential_sale_listings where broker_id is not null
    union select distinct broker_id from residential_rent_listings where broker_id is not null
    union select distinct broker_id from commercial_sale_listings where broker_id is not null
    union select distinct broker_id from commercial_rent_listings where broker_id is not null
    union select distinct broker_id from residential_sale_requirements where broker_id is not null
    union select distinct broker_id from residential_rent_requirements where broker_id is not null
    union select distinct broker_id from commercial_sale_requirements where broker_id is not null
    union select distinct broker_id from commercial_rent_requirements where broker_id is not null;
    create unique index _typed_broker_ids_idx on _typed_broker_ids (broker_id);

    -- These derived tables have legacy parsed_output foreign keys/data. Typed
    -- rows are now the evidence source; detail views read them directly.
    truncate table broker_observations;
    truncate table broker_aliases;
    truncate table broker_phones;
    truncate table broker_market_stats;
    truncate table broker_building_stats;

    with grouped as (
        select broker_key as identity_key,
               mode() within group (order by coalesce(nullif(btrim(broker_name), ''), nullif(btrim(broker_phone), ''))) as canonical_name,
               mode() within group (order by nullif(right(regexp_replace(coalesce(broker_phone, ''), '\D', '', 'g'), 10), '')) as primary_phone,
               min(created_at) as first_seen_val,
               max(coalesce(updated_at, created_at)) as last_seen_val,
               count(*) as obs_count,
               count(*) filter (where role = 'listing') as listing_c,
               count(*) filter (where role = 'requirement') as requirement_c,
               count(distinct group_name) filter (where nullif(btrim(group_name), '') is not null) as group_c,
               count(distinct micro_market) filter (where nullif(btrim(micro_market), '') is not null) as market_c,
               count(distinct building_name) filter (where nullif(btrim(building_name), '') is not null) as building_c,
               count(distinct date(coalesce(updated_at, created_at))) as active_days
          from _typed_broker_source
         where broker_key is not null
         group by broker_key
    )
    insert into brokers (identity_key, canonical_name, primary_phone, first_seen_at,
        last_seen_at, observation_count, listing_count, requirement_count,
        group_count, market_count, building_count, active_days_30, updated_at)
    select identity_key, canonical_name, primary_phone, first_seen_val, last_seen_val,
           obs_count, listing_c, requirement_c, group_c, market_c, building_c,
           active_days, now()
      from grouped
    on conflict (identity_key) do update set
        canonical_name = excluded.canonical_name,
        primary_phone = excluded.primary_phone,
        first_seen_at = excluded.first_seen_at,
        last_seen_at = excluded.last_seen_at,
        observation_count = excluded.observation_count,
        listing_count = excluded.listing_count,
        requirement_count = excluded.requirement_count,
        group_count = excluded.group_count,
        market_count = excluded.market_count,
        building_count = excluded.building_count,
        active_days_30 = excluded.active_days_30,
        updated_at = now();

    get diagnostics total_brokers = row_count;

    -- Do not leave pre-cutover identities in the directory unless a typed row
    -- still references their broker_id.
    delete from brokers b
     where not exists (
         select 1 from _typed_broker_source s
         where s.broker_key = b.identity_key
     )
       and not exists (select 1 from _typed_broker_ids ids where ids.broker_id = b.id);

    insert into broker_aliases (broker_id, alias, observation_count, first_seen_at, last_seen_at)
    select b.id, s.broker_name, count(*)::integer, min(s.created_at), max(coalesce(s.updated_at, s.created_at))
      from _typed_broker_source s
      join brokers b on b.identity_key = s.broker_key
     where nullif(btrim(s.broker_name), '') is not null
     group by b.id, s.broker_name;

    insert into broker_phones (broker_id, phone, observation_count, first_seen_at, last_seen_at)
    select b.id, right(regexp_replace(s.broker_phone, '\D', '', 'g'), 10), count(*)::integer,
           min(s.created_at), max(coalesce(s.updated_at, s.created_at))
      from _typed_broker_source s
      join brokers b on b.identity_key = s.broker_key
     where length(regexp_replace(coalesce(s.broker_phone, ''), '\D', '', 'g')) >= 10
     group by b.id, right(regexp_replace(s.broker_phone, '\D', '', 'g'), 10);

    insert into broker_market_stats (broker_id, micro_market, observation_count, listing_count, requirement_count, last_seen_at)
    select b.id, s.micro_market, count(*)::integer,
           count(*) filter (where s.role = 'listing')::integer,
           count(*) filter (where s.role = 'requirement')::integer,
           max(coalesce(s.updated_at, s.created_at))
      from _typed_broker_source s
      join brokers b on b.identity_key = s.broker_key
     where nullif(btrim(s.micro_market), '') is not null
     group by b.id, s.micro_market;

    insert into broker_building_stats (broker_id, building_name, observation_count, listing_count, requirement_count, last_seen_at)
    select b.id, s.building_name, count(*)::integer,
           count(*) filter (where s.role = 'listing')::integer,
           count(*) filter (where s.role = 'requirement')::integer,
           max(coalesce(s.updated_at, s.created_at))
      from _typed_broker_source s
      join brokers b on b.identity_key = s.broker_key
     where nullif(btrim(s.building_name), '') is not null
     group by b.id, s.building_name;

    select coalesce(sum(observation_count), 0)::integer into total_observations from brokers;
    return jsonb_build_object('brokers', total_brokers, 'observations', total_observations, 'source', 'typed_tables');
end;
$$;

comment on function public.rebuild_broker_graph() is
  'Rebuilds broker aggregates from the eight typed extraction tables; parsed_output is not a source.';
