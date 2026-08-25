-- Quarantine values that are clearly not a property total/monthly rent.
-- Keep the typed row and source evidence; remove only the unsafe numeric from
-- public projections until a correction or review supplies a real value.
do $$
declare
  table_name text;
  price_column text;
  minimum_value numeric;
begin
  for table_name, price_column, minimum_value in
    select * from (values
      ('residential_sale_listings', 'total_asking_price', 100000::numeric),
      ('residential_rent_listings', 'monthly_rent', 1000::numeric),
      ('commercial_sale_listings', 'total_asking_price', 1000000::numeric),
      ('commercial_rent_listings', 'monthly_rent', 1000::numeric)
    ) as rules(table_name, price_column, minimum_value)
  loop
    execute format($sql$
      update public.%I
      set %I = null,
          needs_review = true,
          extraction_confidence = 'low',
          validation_flags = coalesce(validation_flags, '[]'::jsonb)
            || '["price_below_property_scale", "price_nullified_by_validation"]'::jsonb,
          updated_at = now()
      where %I is not null
        and %I > 0
        and %I < %L::numeric
    $sql$, table_name, price_column, price_column, price_column, price_column, minimum_value);
  end loop;
end $$;

create or replace function public.get_locality_counts()
returns table(micro_market text, listing_count bigint)
language sql stable
set search_path to 'public', 'pg_temp'
as $function$
  select micro_market, count(*)::bigint
  from public.listings_unified
  where micro_market is not null
    and micro_market <> ''
    and last_seen > now() - interval '30 days'
    and needs_review is not true
  group by micro_market
  order by count(*) desc;
$function$;

create or replace function public.get_public_counts()
returns table(
  listings_total bigint,
  listings_active_30d bigint,
  brokers bigint,
  localities bigint,
  raw_messages bigint,
  buildings bigint
)
language sql stable
set search_path to 'public', 'pg_temp'
as $function$
  select
    (select count(*) from public.listings_unified where needs_review is not true),
    (select count(*) from public.listings_unified where last_seen >= now() - interval '30 days' and needs_review is not true),
    (select count(*) from public.brokers),
    (select count(distinct micro_market) from public.listings_unified
      where micro_market is not null and micro_market <> ''
        and last_seen >= now() - interval '30 days' and needs_review is not true),
    (select count(*) from public.raw_messages),
    (select count(*) from public.buildings);
$function$;

grant execute on function public.get_locality_counts() to anon, authenticated, service_role;
grant execute on function public.get_public_counts() to anon, authenticated, service_role;
notify pgrst, 'reload schema';
