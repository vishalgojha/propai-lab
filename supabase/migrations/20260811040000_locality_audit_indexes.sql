-- Keep the required locality audit queries bounded as the shared network grows.
create index if not exists idx_locality_reference_sub_norm
  on public.locality_reference (lower(trim(sub_locality)));
create index if not exists idx_locality_reference_parent_norm
  on public.locality_reference (lower(trim(parent_locality)));
create index if not exists idx_residential_sale_locality_resolved_norm
  on public.residential_sale_listings (lower(trim(locality_resolved)));
create index if not exists idx_residential_rent_locality_resolved_norm
  on public.residential_rent_listings (lower(trim(locality_resolved)));
create index if not exists idx_commercial_sale_locality_resolved_norm
  on public.commercial_sale_listings (lower(trim(locality_resolved)));
create index if not exists idx_commercial_rent_locality_resolved_norm
  on public.commercial_rent_listings (lower(trim(locality_resolved)));
