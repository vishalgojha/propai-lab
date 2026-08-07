-- Canonicalize configuration labels so typed rows do not expose numeric
-- formatting such as "2.0" to downstream consumers.
-- Keep the numeric bhk column unchanged; configuration_type is the
-- human-readable, evidence-derived label.

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'residential_sale_listings',
    'residential_rent_listings',
    'commercial_sale_listings',
    'commercial_rent_listings',
    'residential_sale_requirements',
    'residential_rent_requirements',
    'commercial_sale_requirements',
    'commercial_rent_requirements'
  ] LOOP
    EXECUTE format($sql$
      UPDATE public.%I
      SET configuration_type = CASE
        WHEN bhk = 0.5 THEN '1 RK'
        WHEN bhk IS NOT NULL
          AND configuration_type ~ '^\s*[0-9]+(\.[0-9]+)?\s*(BHK|RK)?\s*$'
          THEN trim(to_char(bhk, 'FM999999990.################')) || ' BHK'
        WHEN configuration_type ~ '^\s*[0-9]+(\.0+)?\s*$'
          THEN trim(to_char(configuration_type::numeric, 'FM999999990.################')) || ' BHK'
        WHEN configuration_type ~* '^\s*[0-9]+(\.[0-9]+)?\s*(BHK|RK)\s*$'
          THEN regexp_replace(upper(trim(configuration_type)), '\s+', ' ', 'g')
        ELSE configuration_type
      END
      WHERE configuration_type IS NOT NULL
    $sql$, table_name);
  END LOOP;
END $$;
