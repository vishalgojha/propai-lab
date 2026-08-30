-- Preserve source-grounded broker context that has no canonical typed field.
-- This is evidence, not a license to infer facts or expose private contacts.
alter table public.residential_sale_listings add column if not exists source_notes text;
alter table public.residential_rent_listings add column if not exists source_notes text;
alter table public.commercial_sale_listings add column if not exists source_notes text;
alter table public.commercial_rent_listings add column if not exists source_notes text;
alter table public.residential_sale_requirements add column if not exists source_notes text;
alter table public.residential_rent_requirements add column if not exists source_notes text;
alter table public.commercial_sale_requirements add column if not exists source_notes text;
alter table public.commercial_rent_requirements add column if not exists source_notes text;

comment on column public.residential_sale_listings.source_notes is
  'Source-grounded non-canonical context; never inferred and not public by default';
comment on column public.residential_rent_listings.source_notes is
  'Source-grounded non-canonical context; never inferred and not public by default';
