-- Keep the public homepage market snapshot tied to the buyer-facing listing
-- projection. These are descriptive counts, not operational broker totals.
create function public.get_public_market_metrics()
returns table(
  listings_total bigint,
  listings_fresh_7d bigint,
  brokers bigint,
  localities bigint
)
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $function$
  select
    (select count(*) from public.listings_unified_public),
    -- Freshness is explicitly defined as seen in the last 7 days.
    (select count(*) from public.listings_unified_public
      where last_seen >= now() - interval '7 days'),
    (select count(distinct broker_id) from public.listings_unified_public
      where broker_id is not null),
    (select count(distinct coalesce(
      nullif(trim(micro_market), ''),
      nullif(trim(locality_resolved), ''),
      nullif(trim(locality_raw), '')
    )) from public.listings_unified_public);
$function$;

grant execute on function public.get_public_market_metrics() to anon, authenticated, service_role;
notify pgrst, 'reload schema';
