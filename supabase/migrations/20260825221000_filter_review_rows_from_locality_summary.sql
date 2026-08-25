-- Keep the locality summary RPC aligned with the public listing/read path.
-- Rows needing review remain in typed tables for audit, but are not public
-- inventory or counters.
create or replace function public.get_locality_summary(p_slug text)
returns jsonb
language sql stable
set search_path to 'public', 'pg_temp'
as $function$
with active as materialized (
  select building_name, price, price_unit, bhk, intent,
         coalesce(canonical_micro_market_slug,
           nullif(trim(both '-' from regexp_replace(lower(coalesce(micro_market, locality_resolved, locality_raw, '')), '[^a-z0-9]+', '-', 'g')), '')) as locality_slug
  from public.listings_unified
  where coalesce(canonical_micro_market_slug,
           nullif(trim(both '-' from regexp_replace(lower(coalesce(micro_market, locality_resolved, locality_raw, '')), '[^a-z0-9]+', '-', 'g')), '')) = p_slug
    and last_seen > now() - interval '30 days'
    and needs_review is not true
), building_rows as (
  select lower(trim(coalesce(building_name, ''))) as group_key,
         max(nullif(trim(building_name), '')) as building_name,
         count(*)::bigint as listing_count,
         min(price) as min_price,
         max(price) as max_price,
         max(price_unit) as price_unit,
         string_agg(distinct bhk, ', ' order by bhk) as bhk_raw
  from active
  where nullif(trim(building_name), '') is not null
  group by lower(trim(coalesce(building_name, '')))
), building_json as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'name', building_name, 'listing_count', listing_count,
    'min_price', min_price, 'max_price', max_price,
    'price_unit', price_unit, 'bhk_raw', bhk_raw
  ) order by listing_count desc, building_name), '[]'::jsonb) as value
  from building_rows
), top_bhk as (
  select regexp_replace(bhk, '[^0-9].*$', '') || ' BHK' as value
  from active
  where bhk ~ '^[0-9]+'
  group by regexp_replace(bhk, '[^0-9].*$', '')
  order by count(*) desc, regexp_replace(bhk, '[^0-9].*$', '')
  limit 1
)
select jsonb_build_object(
  'buildings', (select value from building_json),
  'total_count', (select count(*)::bigint from active),
  'rent_count', (select count(*) filter (where lower(coalesce(intent, '')) in ('rent', 'rental', 'lease'))::bigint from active),
  'sale_count', (select count(*) filter (where lower(coalesce(intent, '')) in ('sale', 'sell', 'buy'))::bigint from active),
  'top_bhk', (select value from top_bhk)
);
$function$;

grant execute on function public.get_locality_summary(text)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
