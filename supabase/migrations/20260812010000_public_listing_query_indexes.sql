-- The public site reads listings_unified, a UNION ALL view over the four
-- typed listing tables.  Filters on the view's derived last_seen and
-- canonical_micro_market_slug cannot use an index unless the equivalent
-- expressions exist on every source table.

DO $$
DECLARE
  table_name text;
  table_names text[] := ARRAY[
    'residential_sale_listings',
    'residential_rent_listings',
    'commercial_sale_listings',
    'commercial_rent_listings'
  ];
BEGIN
  FOREACH table_name IN ARRAY table_names LOOP
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I ((coalesce(updated_at, created_at)) DESC) WHERE building_name IS NOT NULL',
      'idx_' || table_name || '_public_last_seen', table_name
    );

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I ((nullif(trim(both ''-'' from regexp_replace(lower(coalesce(micro_market, locality_resolved, locality_raw, '''')), ''[^a-z0-9]+'', ''-'', ''g'')), '''')))',
      'idx_' || table_name || '_public_locality_slug', table_name
    );

  END LOOP;
END $$;

-- Keep the public counters exact, but avoid expanding the wide compatibility
-- view just to count rows.
CREATE OR REPLACE FUNCTION public.get_public_counts()
RETURNS TABLE(
  listings_total bigint,
  listings_active_30d bigint,
  brokers bigint,
  localities bigint,
  raw_messages bigint,
  buildings bigint
)
LANGUAGE sql STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH all_listings AS (
    SELECT micro_market, last_seen_at FROM public.residential_sale_listings
    UNION ALL SELECT micro_market, last_seen_at FROM public.residential_rent_listings
    UNION ALL SELECT micro_market, last_seen_at FROM public.commercial_sale_listings
    UNION ALL SELECT micro_market, last_seen_at FROM public.commercial_rent_listings
  )
  SELECT
    (SELECT count(*) FROM all_listings),
    (SELECT count(*) FROM all_listings WHERE last_seen_at >= now() - interval '30 days'),
    (SELECT count(*) FROM public.brokers),
    (SELECT count(DISTINCT micro_market) FROM all_listings
      WHERE micro_market IS NOT NULL AND btrim(micro_market) <> ''
        AND last_seen_at >= now() - interval '30 days'),
    (SELECT count(*) FROM public.raw_messages),
    (SELECT count(*) FROM public.buildings);
$function$;

GRANT EXECUTE ON FUNCTION public.get_public_counts()
  TO anon, authenticated, service_role;

ANALYZE public.residential_sale_listings;
ANALYZE public.residential_rent_listings;
ANALYZE public.commercial_sale_listings;
ANALYZE public.commercial_rent_listings;
