-- Preserve explicit office facilities that were present in broker messages but
-- had no dedicated typed destination. Additive and nullable for old rows.
begin;

alter table public.commercial_sale_listings
  add column if not exists manager_cabin_count integer,
  add column if not exists telephone_booth_count integer,
  add column if not exists ladies_washroom_count integer,
  add column if not exists gents_washroom_count integer,
  add column if not exists play_area boolean;

alter table public.commercial_rent_listings
  add column if not exists manager_cabin_count integer,
  add column if not exists telephone_booth_count integer,
  add column if not exists ladies_washroom_count integer,
  add column if not exists gents_washroom_count integer,
  add column if not exists play_area boolean;

commit;
