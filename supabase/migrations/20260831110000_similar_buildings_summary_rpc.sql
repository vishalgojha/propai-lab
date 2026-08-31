-- Aggregate the complete fresh locality set in SQL for public building pages.
-- The previous client query fetched only the first 500 rows, which made
-- Similar Buildings counts depend on row order instead of the true count.
create or replace function public.get_similar_buildings(
  p_slug text,
  p_building_name text
)
returns jsonb
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
with active as materialized (
  select building_name, price, price_unit
  from public.listings_unified
  where canonical_micro_market_slug = p_slug
    and last_seen > now() - interval '30 days'
    and needs_review is not true
    and nullif(trim(building_name), '') is not null
), named as (
  select a.building_name, a.price, a.price_unit, b.canonical_name
  from active a
  join lateral (
    select b.canonical_name
    from public.buildings b
    where b.canonical_name is not null
      and lower(trim(b.canonical_name)) = lower(trim(a.building_name))
    order by b.id
    limit 1
  ) b on true
), grouped as (
  select trim(canonical_name) as name,
         count(*)::bigint as listing_count,
         avg(price) as avg_price,
         max(price_unit) as price_unit
  from named
  where lower(trim(canonical_name)) <> lower(trim(p_building_name))
  group by lower(trim(canonical_name)), trim(canonical_name)
)
select coalesce(jsonb_agg(jsonb_build_object(
  'name', name,
  'listing_count', listing_count,
  'avg_price', avg_price,
  'price_unit', price_unit
) order by listing_count desc, name), '[]'::jsonb)
from (
  select *
  from grouped
  order by listing_count desc, name
  limit 6
) top_buildings;
$function$;

grant execute on function public.get_similar_buildings(text, text)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
