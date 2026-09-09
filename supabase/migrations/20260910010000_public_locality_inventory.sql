-- Read-only inventory intelligence. No second listings table, no review gate,
-- no LIMIT/sample, no guessed unit deduplication. One statement = one snapshot.
create or replace function public.get_public_locality_inventory()
returns jsonb
language sql stable security invoker
set search_path = ''
as $$
with recent as (
  select canonical_micro_market_slug, micro_market, locality_resolved, locality_raw, card_type,
    case when bhk::text ~ '^([1-9]|1[0-9])([.]5)?([[:space:]]*[Bb][Hh][Kk])?$'
      then substring(bhk::text from '^([0-9]+([.]5)?)') else null end as configuration,
    last_seen, price, price_unit, price_model, price_per_sqft
  -- The public view adds correlated typed-table fields and is too expensive
  -- for a full aggregate. This RPC is server-only and returns only grouped,
  -- source-safe metrics, so read the indexed canonical ledger directly.
  from public.listings_unified
  where last_seen >= now() - interval '30 days' and last_seen <= now()
    and nullif(trim(summary_title), '') is not null
    and trim(summary_title) !~* '^\[(unstructured|unknown|listing)\]'
    and card_type in ('residential_rent', 'residential_sale', 'commercial_rent', 'commercial_sale')
), checked as (
  select *, case
    -- Conservative comparison set: an unambiguous total quote must agree
    -- with the stored absolute amount. PSF, multiple options and conflicts
    -- remain in inventory counts but do not become a price benchmark.
    when price_unit in ('abs', 'total') and coalesce(price_model, 'total') not in ('psf', 'per_sqft')
      and price_per_sqft is null
      and ((card_type = 'residential_rent' and price between 1000 and 10000000)
        or (card_type = 'residential_sale' and price between 100000 and 10000000000)
        or (card_type like 'commercial_%' and price between 1000 and 10000000000))
    then price else null end as comparable_price
  from recent
), groups as (
  select canonical_micro_market_slug, max(micro_market) as micro_market,
    max(locality_resolved) as locality_resolved, max(locality_raw) as locality_raw, card_type, configuration,
    count(*) as listing_count,
    count(*) filter (where last_seen >= now() - interval '24 hours') as active_24h,
    max(last_seen) as last_seen,
    count(comparable_price) as priced_count,
    min(comparable_price) as min_price, max(comparable_price) as max_price
  from checked
  group by canonical_micro_market_slug, card_type, configuration
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
