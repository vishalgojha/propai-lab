-- The public locality page uses this aggregate to avoid downloading every
-- active listing into the Next.js server. Keep it over the live typed read
-- model so locality pages continue working after the typed-schema cutover.

CREATE OR REPLACE FUNCTION public.get_locality_summary(p_slug text)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'buildings', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'name', b.building_name,
          'listing_count', b.listing_count,
          'min_price', b.min_price,
          'max_price', b.max_price,
          'price_unit', b.price_unit,
          'bhk_raw', b.bhk_raw
        )
        ORDER BY b.listing_count DESC, b.building_name
      )
      FROM (
        SELECT
          building_name,
          count(*)::bigint AS listing_count,
          min(price) AS min_price,
          max(price) AS max_price,
          max(price_unit) AS price_unit,
          string_agg(DISTINCT bhk, ', ' ORDER BY bhk) AS bhk_raw
        FROM public.listings_unified
        WHERE canonical_micro_market_slug = p_slug
          AND last_seen > now() - interval '30 days'
        GROUP BY building_name
      ) AS b
    ), '[]'::jsonb),
    'total_count', (
      SELECT count(*)::bigint
      FROM public.listings_unified
      WHERE canonical_micro_market_slug = p_slug
        AND last_seen > now() - interval '30 days'
    ),
    'rent_count', (
      SELECT count(*)::bigint
      FROM public.listings_unified
      WHERE canonical_micro_market_slug = p_slug
        AND last_seen > now() - interval '30 days'
        AND lower(coalesce(intent, '')) IN ('rent', 'rental', 'lease')
    ),
    'sale_count', (
      SELECT count(*)::bigint
      FROM public.listings_unified
      WHERE canonical_micro_market_slug = p_slug
        AND last_seen > now() - interval '30 days'
        AND lower(coalesce(intent, '')) IN ('sale', 'sell', 'buy')
    ),
    'top_bhk', (
      SELECT regexp_replace(bhk, '[^0-9].*$', '') || ' BHK'
      FROM public.listings_unified
      WHERE canonical_micro_market_slug = p_slug
        AND last_seen > now() - interval '30 days'
        AND bhk ~ '^[0-9]+'
      GROUP BY regexp_replace(bhk, '[^0-9].*$', '')
      ORDER BY count(*) DESC, regexp_replace(bhk, '[^0-9].*$', '')
      LIMIT 1
    )
  );
$function$;

GRANT EXECUTE ON FUNCTION public.get_locality_summary(text)
  TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
