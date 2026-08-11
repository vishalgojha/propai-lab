-- Persist the visibility decision for listings created outside WhatsApp.
-- Historical rows remain nullable: this migration does not rewrite them.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'residential_sale_listings',
    'residential_rent_listings',
    'commercial_sale_listings',
    'commercial_rent_listings',
    'residential_sale_requirements',
    'residential_rent_requirements',
    'commercial_sale_requirements',
    'commercial_rent_requirements'
  ] loop
    execute format(
      'alter table public.%I add column if not exists visibility text check (visibility in (''shared_market'', ''workspace_private''))',
      table_name
    );
    execute format(
      'alter table public.%I add column if not exists source_scope text',
      table_name
    );
  end loop;
end $$;

create index if not exists idx_residential_sale_listing_visibility
  on public.residential_sale_listings (visibility);
create index if not exists idx_residential_rent_listing_visibility
  on public.residential_rent_listings (visibility);
create index if not exists idx_commercial_sale_listing_visibility
  on public.commercial_sale_listings (visibility);
create index if not exists idx_commercial_rent_listing_visibility
  on public.commercial_rent_listings (visibility);
