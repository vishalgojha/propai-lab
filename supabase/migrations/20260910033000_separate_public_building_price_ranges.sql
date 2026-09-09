-- Public building summaries must never present rent and sale quotes as one
-- comparable range. Keep both transaction types in the same building card,
-- but return separate ranges for each.
create or replace function public.get_locality_summary(p_slug text)
returns jsonb
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
with active as materialized (
  select building_name, price, price_unit, bhk, intent
  from public.listings_unified
  where canonical_micro_market_slug = p_slug
    and last_seen > now() - interval '30 days'
), building_rows as (
  select building_name,
    count(*)::bigint as listing_count,
    min(price) as min_price,
    max(price) as max_price,
    max(price_unit) as price_unit,
    min(price) filter (where lower(coalesce(intent, '')) in ('rent', 'rental', 'lease')) as rent_min_price,
    max(price) filter (where lower(coalesce(intent, '')) in ('rent', 'rental', 'lease')) as rent_max_price,
    min(price) filter (where lower(coalesce(intent, '')) in ('sale', 'sell', 'buy')) as sale_min_price,
    max(price) filter (where lower(coalesce(intent, '')) in ('sale', 'sell', 'buy')) as sale_max_price,
    string_agg(distinct bhk, ', ' order by bhk) as bhk_raw
  from active
  group by building_name
), building_json as (
  select coalesce(jsonb_agg(jsonb_build_object(
    'name', building_name,
    'listing_count', listing_count,
    'min_price', min_price,
    'max_price', max_price,
    'price_unit', price_unit,
    'rent_min_price', rent_min_price,
    'rent_max_price', rent_max_price,
    'sale_min_price', sale_min_price,
    'sale_max_price', sale_max_price,
    'bhk_raw', bhk_raw
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
