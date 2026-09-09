-- Read-only inventory intelligence. No second listings table, no review gate,
-- no LIMIT/sample, no guessed unit deduplication. One statement = one snapshot.
create or replace function public.get_public_locality_inventory()
returns jsonb
language sql stable security invoker
set search_path = ''
as $$
with recent as (
  select micro_market, locality_resolved, locality_raw, card_type,
    case when bhk::text ~ '^([1-9]|1[0-9])([.]5)?([[:space:]]*[Bb][Hh][Kk])?$'
      then substring(bhk::text from '^([0-9]+([.]5)?)') else null end as configuration,
    last_seen, price, price_unit, price_model, price_per_sqft,
    regexp_match(trim(price_raw_text),
      '^(₹|rs[.]?|inr)?[[:space:]]*([0-9][0-9,]*([.][0-9]+)?)[[:space:]]*(lakh|lac|lacs|lakhs|l|crore|crores|cr|k|thousand)?([[:space:]]*/[[:space:]]*(month|mo))?$', 'i') as quote
  from public.listings_unified_public
  where last_seen >= now() - interval '30 days' and last_seen <= now()
    and nullif(trim(summary_title), '') is not null
    and trim(summary_title) !~* '^\[(unstructured|unknown|listing)\]'
    and card_type in ('residential_rent', 'residential_sale', 'commercial_rent', 'commercial_sale')
), amounts as (
  select *, replace(quote[2], ',', '')::numeric *
    case lower(quote[4]) when 'l' then 100000 when 'lac' then 100000
      when 'lacs' then 100000 when 'lakh' then 100000 when 'lakhs' then 100000
      when 'cr' then 10000000 when 'crore' then 10000000 when 'crores' then 10000000
      when 'k' then 1000 when 'thousand' then 1000 else 1 end as quoted_amount
  from recent
), checked as (
  select *, case
    -- Conservative comparison set: an unambiguous total quote must agree
    -- with the stored absolute amount. PSF, multiple options and conflicts
    -- remain in inventory counts but do not become a price benchmark.
    when price_unit = 'abs' and coalesce(price_model, 'total') not in ('psf', 'per_sqft')
      and price_per_sqft is null and abs(price - quoted_amount) <= 1
      and ((card_type = 'residential_rent' and quoted_amount between 1000 and 10000000)
        or (card_type = 'residential_sale' and quote[5] is null and quoted_amount between 100000 and 10000000000))
    then quoted_amount else null end as comparable_price
  from amounts
), groups as (
  select micro_market, locality_resolved, locality_raw, card_type, configuration,
    count(*) as listing_count,
    count(*) filter (where last_seen >= now() - interval '24 hours') as active_24h,
    max(last_seen) as last_seen,
    count(comparable_price) as priced_count,
    min(comparable_price) as min_price, max(comparable_price) as max_price
  from checked
  group by micro_market, locality_resolved, locality_raw, card_type, configuration
)
select jsonb_build_object(
  'as_of', now(), 'window_days', 30,
  'groups', coalesce((select jsonb_agg(to_jsonb(g)) from groups g), '[]'::jsonb),
  'registry', coalesce((select jsonb_agg(jsonb_build_object(
    'sub_locality', sub_locality, 'parent_locality', parent_locality,
    'canonical_locality', canonical_locality, 'city', city, 'alternate_names', alternate_names
  )) from public.locality_reference), '[]'::jsonb)
);
$$;

-- Server-only RPC: raw locality labels are normalized before rendering.
-- Do not grant public callers access to registry metadata through this RPC.
revoke all on function public.get_public_locality_inventory() from public, anon, authenticated;
grant execute on function public.get_public_locality_inventory() to service_role;
comment on function public.get_public_locality_inventory() is
  'Complete 30-day public listing-record aggregates; review flags do not hide inventory. Server-only.';
notify pgrst, 'reload schema';
