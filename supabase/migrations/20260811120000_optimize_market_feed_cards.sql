-- Market Feed card reads are tenant + broker/time bounded. These indexes keep
-- the eight typed source tables from scanning the full extraction history.
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
      'create index if not exists %I on public.%I (tenant_id, created_at desc)',
      table_name || '_feed_tenant_created_idx', table_name
    );
    execute format(
      'create index if not exists %I on public.%I (tenant_id, broker_phone, created_at desc)',
      table_name || '_feed_tenant_broker_created_idx', table_name
    );
  end loop;
end $$;

notify pgrst, 'reload schema';
