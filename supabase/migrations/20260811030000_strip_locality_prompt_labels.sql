-- Remove parser prompt-label leakage without changing the broker text.
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
         SET locality_resolved = trim(regexp_replace(
               locality_resolved,
               '^LOCATION\s*:-\s*',
               '',
               'i'
             )),
             updated_at = now()
       WHERE locality_resolved ~* '^LOCATION\s*:-'
    $sql$, table_name);
  END LOOP;
END $$;
