-- Preserve both ends of an explicitly quoted sale/rent range.
alter table public.residential_sale_listings
  add column if not exists price_max numeric;
alter table public.residential_rent_listings
  add column if not exists monthly_rent_max numeric;
alter table public.commercial_sale_listings
  add column if not exists price_max numeric;
alter table public.commercial_rent_listings
  add column if not exists monthly_rent_max numeric;

comment on column public.residential_sale_listings.price_max is
  'Upper bound of an explicit total sale-price range, in INR.';
comment on column public.residential_rent_listings.monthly_rent_max is
  'Upper bound of an explicit monthly-rent range, in INR.';
comment on column public.commercial_sale_listings.price_max is
  'Upper bound of an explicit total sale-price range, in INR.';
comment on column public.commercial_rent_listings.monthly_rent_max is
  'Upper bound of an explicit monthly-rent range, in INR.';
