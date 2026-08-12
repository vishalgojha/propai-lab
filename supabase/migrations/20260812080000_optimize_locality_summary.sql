-- Keep the locality page's live counts and building summary on one filtered
-- read of the typed listing view. The previous function scanned the view once
-- for buildings and once for each count/top-BHK field.
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

-- The view's canonical slug and freshness predicate are expressions, so the
-- existing standalone micro_market and last_seen indexes cannot be combined
-- by the planner for locality pages.
create index if not exists idx_res_sale_locality_fresh
  on public.residential_sale_listings (
    (nullif(trim(both '-' from regexp_replace(lower(coalesce(micro_market, locality_resolved, locality_raw, '')), '[^a-z0-9]+', '-', 'g')), ''))
  );
create index if not exists idx_res_rent_locality_fresh
  on public.residential_rent_listings (
    (nullif(trim(both '-' from regexp_replace(lower(coalesce(micro_market, locality_resolved, locality_raw, '')), '[^a-z0-9]+', '-', 'g')), ''))
  );
create index if not exists idx_com_sale_locality_fresh
  on public.commercial_sale_listings (
    (nullif(trim(both '-' from regexp_replace(lower(coalesce(micro_market, locality_resolved, locality_raw, '')), '[^a-z0-9]+', '-', 'g')), ''))
  );
create index if not exists idx_com_rent_locality_fresh
  on public.commercial_rent_listings (
    (nullif(trim(both '-' from regexp_replace(lower(coalesce(micro_market, locality_resolved, locality_raw, '')), '[^a-z0-9]+', '-', 'g')), ''))
  );
