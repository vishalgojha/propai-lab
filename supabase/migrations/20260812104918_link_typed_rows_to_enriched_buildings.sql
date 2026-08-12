-- A typed row must retain the canonical building selected during extraction.
-- Without this durable link, enrichment can update only the registry and can
-- never safely propagate locality back to listings with ambiguous names.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'residential_sale_listings', 'residential_rent_listings',
    'commercial_sale_listings', 'commercial_rent_listings',
    'residential_sale_requirements', 'residential_rent_requirements',
    'commercial_sale_requirements', 'commercial_rent_requirements'
  ] loop
    execute format(
      'alter table public.%I add column if not exists building_id bigint references public.buildings(id) on delete set null',
      table_name
    );
    execute format(
      'create index if not exists %I on public.%I (building_id) where building_id is not null',
      'idx_' || table_name || '_building_id', table_name
    );
  end loop;
end $$;
