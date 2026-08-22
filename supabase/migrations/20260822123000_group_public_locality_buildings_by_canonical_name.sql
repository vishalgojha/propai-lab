-- Tenant registries can contain separate rows for the same physical building.
-- The public shared-market locality page must present one physical building
-- card without mutating or merging tenant-owned registry rows.
create or replace function public.get_locality_summary(p_slug text)
returns jsonb
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
with active as materialized (
  select building_name, total_asking_price as price, 'abs'::text as price_unit,
         bhk::text as bhk, 'sale'::text as intent,
         nullif(trim(both '-' from regexp_replace(lower(coalesce(micro_market, locality_resolved, locality_raw, '')), '[^a-z0-9]+', '-', 'g')), '') as locality_slug,
         coalesce(updated_at, created_at) as seen_at
  from public.residential_sale_listings
  where nullif(trim(both '-' from regexp_replace(lower(coalesce(micro_market, locality_resolved, locality_raw, '')), '[^a-z0-9]+', '-', 'g')), '') = p_slug
    and coalesce(updated_at, created_at) > now() - interval '30 days'
  union all
  select building_name, monthly_rent, 'abs'::text, bhk::text, 'rent'::text,
         nullif(trim(both '-' from regexp_replace(lower(coalesce(micro_market, locality_resolved, locality_raw, '')), '[^a-z0-9]+', '-', 'g')), ''),
         coalesce(updated_at, created_at)
  from public.residential_rent_listings
  where nullif(trim(both '-' from regexp_replace(lower(coalesce(micro_market, locality_resolved, locality_raw, '')), '[^a-z0-9]+', '-', 'g')), '') = p_slug
    and coalesce(updated_at, created_at) > now() - interval '30 days'
  union all
  select building_name, total_asking_price, 'abs'::text, null::text, 'sale'::text,
         nullif(trim(both '-' from regexp_replace(lower(coalesce(micro_market, locality_resolved, locality_raw, '')), '[^a-z0-9]+', '-', 'g')), ''),
         coalesce(updated_at, created_at)
  from public.commercial_sale_listings
  where nullif(trim(both '-' from regexp_replace(lower(coalesce(micro_market, locality_resolved, locality_raw, '')), '[^a-z0-9]+', '-', 'g')), '') = p_slug
    and coalesce(updated_at, created_at) > now() - interval '30 days'
  union all
  select building_name, monthly_rent, 'abs'::text, null::text, 'rent'::text,
         nullif(trim(both '-' from regexp_replace(lower(coalesce(micro_market, locality_resolved, locality_raw, '')), '[^a-z0-9]+', '-', 'g')), ''),
         coalesce(updated_at, created_at)
  from public.commercial_rent_listings
  where nullif(trim(both '-' from regexp_replace(lower(coalesce(micro_market, locality_resolved, locality_raw, '')), '[^a-z0-9]+', '-', 'g')), '') = p_slug
    and coalesce(updated_at, created_at) > now() - interval '30 days'
), joined as (
  select a.*,
         coalesce(nullif(trim(b.canonical_name), ''), nullif(trim(a.building_name), '')) as display_name,
         coalesce(lower(trim(b.canonical_name)), lower(trim(a.building_name))) || '|' || a.locality_slug as group_key
  from active a
  left join lateral (
    select canonical_name
    from public.buildings b
    where b.canonical_name is not null
      and lower(trim(b.canonical_name)) = lower(trim(a.building_name))
    order by b.id
    limit 1
  ) b on true
), building_rows as (
  select group_key, max(display_name) as building_name,
    count(*)::bigint as listing_count, min(price) as min_price,
    max(price) as max_price, max(price_unit) as price_unit,
    string_agg(distinct bhk, ', ' order by bhk) as bhk_raw
  from joined
  where nullif(trim(display_name), '') is not null
  group by group_key
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
  'rent_count', (select count(*) filter (where intent = 'rent')::bigint from active),
  'sale_count', (select count(*) filter (where intent = 'sale')::bigint from active),
  'top_bhk', (select value from top_bhk)
);
$function$;

grant execute on function public.get_locality_summary(text)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
