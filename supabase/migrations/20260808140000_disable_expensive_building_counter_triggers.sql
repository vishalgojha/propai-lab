-- Recomputing observed_listings scans every typed table and every building.
-- Running that full aggregation after every extraction insert causes statement
-- timeouts during normal WhatsApp bursts. Keep the counter function available
-- for an explicit maintenance run, but do not put it on the hot ingestion path.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'residential_sale_listings',
    'residential_rent_listings',
    'commercial_sale_listings',
    'commercial_rent_listings'
  ] loop
    execute format(
      'drop trigger if exists trg_refresh_building_observed_listings_%I on public.%I',
      table_name, table_name
    );
  end loop;
end $$;
