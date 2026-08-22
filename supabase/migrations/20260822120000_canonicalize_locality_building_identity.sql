-- Keep public locality aggregates on the canonical building registry.
-- Existing typed rows may predate the resolver link, so only fill building_id
-- when registry/alias evidence identifies exactly one building. Ambiguous
-- names remain unresolved for review; they are never silently merged.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'residential_sale_listings', 'residential_rent_listings',
    'commercial_sale_listings', 'commercial_rent_listings'
  ] loop
    execute format($sql$
      with candidates as (
        select t.id, b.id as building_id
        from public.%1$I t
        join public.buildings b
          on lower(trim(b.canonical_name)) = lower(trim(t.building_name))
          or exists (
            select 1
            from public.building_name_aliases a
            where a.building_id = b.id
              and lower(trim(a.alias)) = lower(trim(t.building_name))
          )
        where t.building_id is null
          and (b.tenant_id is null or b.tenant_id = t.tenant_id)
          and nullif(trim(t.building_name), '') is not null
      ), unique_candidates as (
        select id, min(building_id) as building_id
        from candidates
        group by id
        having count(distinct building_id) = 1
      )
      update public.%1$I t
      set building_id = u.building_id
      from unique_candidates u
      where t.id = u.id
        and t.building_id is null
    $sql$, table_name);
  end loop;
end $$;

-- The RPC reads typed tables directly so it can group on the durable FK and
-- display buildings.canonical_name. Unresolved rows retain their raw name.
create or replace function public.get_locality_summary(p_slug text)
returns jsonb
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
with active as materialized (
  select building_id, building_name, total_asking_price as price,
         'abs'::text as price_unit, bhk::text as bhk, 'sale'::text as intent,
         nullif(trim(both '-' from regexp_replace(lower(coalesce(micro_market, locality_resolved, locality_raw, '')), '[^a-z0-9]+', '-', 'g')), '') as locality_slug,
         coalesce(updated_at, created_at) as seen_at
  from public.residential_sale_listings
  where nullif(trim(both '-' from regexp_replace(lower(coalesce(micro_market, locality_resolved, locality_raw, '')), '[^a-z0-9]+', '-', 'g')), '') = p_slug
    and coalesce(updated_at, created_at) > now() - interval '30 days'
  union all
  select building_id, building_name, monthly_rent,
         'abs'::text, bhk::text, 'rent'::text,
         nullif(trim(both '-' from regexp_replace(lower(coalesce(micro_market, locality_resolved, locality_raw, '')), '[^a-z0-9]+', '-', 'g')), ''),
         coalesce(updated_at, created_at)
  from public.residential_rent_listings
  where nullif(trim(both '-' from regexp_replace(lower(coalesce(micro_market, locality_resolved, locality_raw, '')), '[^a-z0-9]+', '-', 'g')), '') = p_slug
    and coalesce(updated_at, created_at) > now() - interval '30 days'
  union all
  select building_id, building_name, total_asking_price,
         'abs'::text, null::text, 'sale'::text,
         nullif(trim(both '-' from regexp_replace(lower(coalesce(micro_market, locality_resolved, locality_raw, '')), '[^a-z0-9]+', '-', 'g')), ''),
         coalesce(updated_at, created_at)
  from public.commercial_sale_listings
  where nullif(trim(both '-' from regexp_replace(lower(coalesce(micro_market, locality_resolved, locality_raw, '')), '[^a-z0-9]+', '-', 'g')), '') = p_slug
    and coalesce(updated_at, created_at) > now() - interval '30 days'
  union all
  select building_id, building_name, monthly_rent,
         'abs'::text, null::text, 'rent'::text,
         nullif(trim(both '-' from regexp_replace(lower(coalesce(micro_market, locality_resolved, locality_raw, '')), '[^a-z0-9]+', '-', 'g')), ''),
         coalesce(updated_at, created_at)
  from public.commercial_rent_listings
  where nullif(trim(both '-' from regexp_replace(lower(coalesce(micro_market, locality_resolved, locality_raw, '')), '[^a-z0-9]+', '-', 'g')), '') = p_slug
    and coalesce(updated_at, created_at) > now() - interval '30 days'
), joined as (
  select a.*, b.canonical_name,
         coalesce('building:' || b.id::text,
                  'raw:' || lower(trim(coalesce(a.building_name, '')))) as group_key
  from active a
  left join public.buildings b on b.id = a.building_id
), building_rows as (
  select group_key,
    max(coalesce(canonical_name, nullif(trim(building_name), ''))) as building_name,
    count(*)::bigint as listing_count,
    min(price) as min_price,
    max(price) as max_price,
    max(price_unit) as price_unit,
    string_agg(distinct bhk, ', ' order by bhk) as bhk_raw
  from joined
  where nullif(trim(coalesce(building_name, '')), '') is not null
  group by group_key
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
  'rent_count', (select count(*) filter (where intent = 'rent')::bigint from active),
  'sale_count', (select count(*) filter (where intent = 'sale')::bigint from active),
  'top_bhk', (select value from top_bhk)
);
$function$;

grant execute on function public.get_locality_summary(text)
  to anon, authenticated, service_role;

notify pgrst, 'reload schema';
