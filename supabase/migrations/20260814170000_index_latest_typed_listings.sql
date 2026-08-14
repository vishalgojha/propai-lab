-- The public latest-listing ticker must never sort listings_unified, which is
-- a wide UNION ALL view over these four source tables. Keep one small,
-- index-backed newest-row path per typed table instead.
DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'residential_sale_listings',
    'residential_rent_listings',
    'commercial_sale_listings',
    'commercial_rent_listings'
  ] LOOP
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I (updated_at DESC, created_at DESC)',
      'idx_' || table_name || '_latest_seen',
      table_name
    );
  END LOOP;
END $$;

ANALYZE public.residential_sale_listings;
ANALYZE public.residential_rent_listings;
ANALYZE public.commercial_sale_listings;
ANALYZE public.commercial_rent_listings;
