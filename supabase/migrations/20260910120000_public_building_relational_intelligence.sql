-- Live, source-derived building intelligence for the public building page.
-- This is a read model over the existing public projections: no inventory is
-- copied, invented, or manually counted. New records are visible on the next
-- read; the 30-day window matches the public freshness contract.
create or replace function public.get_public_building_relational_intelligence(
  p_building_id bigint
)
returns jsonb
language sql
stable
security invoker
set search_path to 'public', 'pg_temp'
as $function$
with target as materialized (
  select id, canonical_name, micro_market, latitude, longitude
  from public.buildings_public
  where id = p_building_id
), active as materialized (
  select l.*
  from public.listings_unified_public l
  join target t on lower(trim(l.building_name)) = lower(trim(t.canonical_name))
    and lower(trim(coalesce(l.micro_market, ''))) = lower(trim(coalesce(t.micro_market, '')))
  where l.last_seen > now() - interval '30 days'
    and l.last_seen <= now()
    and nullif(trim(l.summary_title), '') is not null
    and trim(l.summary_title) !~* '^\[(unstructured|unknown|listing)\]'
), priced as (
  select *,
    case when price is not null and price > 0
      and coalesce(price_model, 'total') not in ('psf', 'per_sqft')
      and coalesce(price_unit, 'abs') in ('abs', 'total', '')
      then price else null end as comparable_price
  from active
), building_stats as (
  select
    count(*)::integer as listing_count,
    count(*) filter (where lower(coalesce(intent, '')) in ('rent', 'rental', 'lease'))::integer as rent_count,
    count(*) filter (where lower(coalesce(intent, '')) in ('sale', 'sell', 'buy'))::integer as sale_count,
    count(*) filter (where last_seen >= now() - interval '7 days')::integer as fresh_7d,
    count(distinct broker_id)::integer as broker_count,
    max(last_seen) as last_updated,
    min(comparable_price) filter (where lower(coalesce(intent, '')) in ('rent', 'rental', 'lease')) as rent_min_price,
    max(comparable_price) filter (where lower(coalesce(intent, '')) in ('rent', 'rental', 'lease')) as rent_max_price,
    min(comparable_price) filter (where lower(coalesce(intent, '')) in ('sale', 'sell', 'buy')) as sale_min_price,
    max(comparable_price) filter (where lower(coalesce(intent, '')) in ('sale', 'sell', 'buy')) as sale_max_price
  from priced
), configurations as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'bhk', bhk, 'listing_count', listing_count, 'rent_count', rent_count, 'sale_count', sale_count
  ) order by bhk), '[]'::jsonb) as value
  from (
    select trim(bhk) as bhk,
      count(*)::integer as listing_count,
      count(*) filter (where lower(coalesce(intent, '')) in ('rent', 'rental', 'lease'))::integer as rent_count,
      count(*) filter (where lower(coalesce(intent, '')) in ('sale', 'sell', 'buy'))::integer as sale_count
    from active
    where trim(coalesce(bhk, '')) ~ '^[0-9]+([.]5)?[[:space:]]*[Bb][Hh][Kk]$'
    group by trim(bhk)
  ) grouped
), nearby as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', x.id, 'name', x.name, 'micro_market', x.micro_market,
    'address', x.address, 'distance_m', round(x.distance_m::numeric),
    'listing_count', x.listing_count, 'last_updated', x.last_updated
  ) order by x.distance_m, x.name), '[]'::jsonb) as value
  from (
    select b.id, b.canonical_name as name, b.micro_market, b.address,
      6371000.0 * 2.0 * asin(sqrt(
        power(sin(radians((b.latitude - t.latitude) / 2.0)), 2) +
        cos(radians(t.latitude)) * cos(radians(b.latitude)) *
        power(sin(radians((b.longitude - t.longitude) / 2.0)), 2)
      )) as distance_m,
      count(l.*)::integer as listing_count,
      max(l.last_seen) as last_updated
    from public.buildings_public b
    join target t on t.latitude is not null and t.longitude is not null
      and b.latitude is not null and b.longitude is not null
      and b.id <> t.id
      and 6371000.0 * 2.0 * asin(sqrt(
        power(sin(radians((b.latitude - t.latitude) / 2.0)), 2) +
        cos(radians(t.latitude)) * cos(radians(b.latitude)) *
        power(sin(radians((b.longitude - t.longitude) / 2.0)), 2)
      )) <= 1000
    left join public.listings_unified_public l
      on lower(trim(l.building_name)) = lower(trim(b.canonical_name))
      and lower(trim(coalesce(l.micro_market, ''))) = lower(trim(coalesce(b.micro_market, '')))
      and l.last_seen > now() - interval '30 days'
      and l.last_seen <= now()
      and nullif(trim(l.summary_title), '') is not null
    group by b.id, b.canonical_name, b.micro_market, b.address,
      b.latitude, b.longitude, t.latitude, t.longitude
    having count(l.*) > 0
    order by distance_m, b.canonical_name
    limit 8
  ) x
), locality_stats as (
  select
    count(*)::integer as listing_count,
    count(distinct nullif(trim(building_name), ''))::integer as building_count,
    count(*) filter (where last_seen >= now() - interval '7 days')::integer as fresh_7d
  from public.listings_unified_public l
  join target t on lower(trim(coalesce(l.micro_market, ''))) = lower(trim(coalesce(t.micro_market, '')))
  where l.last_seen > now() - interval '30 days'
    and l.last_seen <= now()
    and nullif(trim(l.summary_title), '') is not null
)
select jsonb_build_object(
  'as_of', now(), 'window_days', 30,
  'building', (select to_jsonb(t) from target t),
  'building_stats', (select to_jsonb(s) from building_stats s),
  'configurations', (select value from configurations),
  'nearby_buildings', (select value from nearby),
  'locality_stats', (select to_jsonb(s) from locality_stats s)
);
$function$;

grant execute on function public.get_public_building_relational_intelligence(bigint)
  to anon, authenticated, service_role;

comment on function public.get_public_building_relational_intelligence(bigint) is
  'Live 30-day source-derived building and locality relationships; no copied inventory or unsupported market claims.';

notify pgrst, 'reload schema';
