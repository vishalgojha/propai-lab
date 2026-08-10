-- Mangal Kunj is on 36th Road near National College, Bandra West.
-- A handful of low-confidence parser rows incorrectly assigned Andheri West.
-- Keep the broker source slice unchanged; correct only the derived market.
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
    EXECUTE format($sql$
      UPDATE public.%I
         SET micro_market = 'Bandra West',
             updated_at = now(),
             corrected_fields = CASE
               WHEN corrected_fields IS NULL
                 THEN ARRAY['micro_market']::text[]
               WHEN NOT ('micro_market' = ANY(corrected_fields))
                 THEN array_append(corrected_fields, 'micro_market')
               ELSE corrected_fields
             END
       WHERE lower(building_name) LIKE '%%mangal kunj%%'
         AND micro_market = 'Andheri West'
         AND (
           raw_payload::text ILIKE '%%36th Rd%%'
           OR raw_payload::text ILIKE '%%National College%%'
         )
    $sql$, table_name);
  END LOOP;
END $$;
