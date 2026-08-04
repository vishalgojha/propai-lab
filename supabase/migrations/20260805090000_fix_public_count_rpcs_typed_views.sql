-- Public site RPCs must read the live typed listing view.
-- The legacy listings table was retired during the typed-schema migration.

CREATE OR REPLACE FUNCTION public.get_locality_counts()
RETURNS TABLE(micro_market text, listing_count bigint)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    micro_market,
    count(*) AS listing_count
  FROM public.listings_unified
  WHERE micro_market IS NOT NULL
    AND micro_market <> ''
    AND last_seen > now() - interval '30 days'
  GROUP BY micro_market
  ORDER BY listing_count DESC;
$function$;

CREATE OR REPLACE FUNCTION public.get_public_counts()
RETURNS TABLE(
  listings_total bigint,
  listings_active_30d bigint,
  brokers bigint,
  localities bigint,
  raw_messages bigint,
  buildings bigint
)
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT
    (SELECT count(*) FROM public.listings_unified) AS listings_total,
    (SELECT count(*) FROM public.listings_unified
      WHERE last_seen >= now() - interval '30 days') AS listings_active_30d,
    (SELECT count(*) FROM public.brokers) AS brokers,
    (SELECT count(DISTINCT micro_market) FROM public.listings_unified
      WHERE micro_market IS NOT NULL
        AND micro_market <> ''
        AND last_seen >= now() - interval '30 days') AS localities,
    (SELECT count(*) FROM public.raw_messages) AS raw_messages,
    (SELECT count(*) FROM public.buildings) AS buildings;
$function$;

GRANT EXECUTE ON FUNCTION public.get_locality_counts() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_public_counts() TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
