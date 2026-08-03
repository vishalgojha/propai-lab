-- Keep typed_parsed_output lookups by the stable observation id indexable.
-- The migration is applied to production through Supabase tooling as well.
begin;

create index if not exists idx_residential_sale_listings_legacy_source_id
  on public.residential_sale_listings (legacy_source_id);
create index if not exists idx_residential_rent_listings_legacy_source_id
  on public.residential_rent_listings (legacy_source_id);
create index if not exists idx_commercial_sale_listings_legacy_source_id
  on public.commercial_sale_listings (legacy_source_id);
create index if not exists idx_commercial_rent_listings_legacy_source_id
  on public.commercial_rent_listings (legacy_source_id);
create index if not exists idx_residential_sale_requirements_legacy_source_id
  on public.residential_sale_requirements (legacy_source_id);
create index if not exists idx_residential_rent_requirements_legacy_source_id
  on public.residential_rent_requirements (legacy_source_id);
create index if not exists idx_commercial_sale_requirements_legacy_source_id
  on public.commercial_sale_requirements (legacy_source_id);
create index if not exists idx_commercial_rent_requirements_legacy_source_id
  on public.commercial_rent_requirements (legacy_source_id);

commit;
