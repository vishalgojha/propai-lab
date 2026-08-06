-- Commercial-rent extraction schema and broker metadata.
-- Additive only: existing rows remain unchanged and nullable fields are safe
-- for older observations that do not contain these facts.
begin;

alter table public.commercial_rent_listings
  add column if not exists super_built_up_area_sqft numeric,
  add column if not exists saleable_area_sqft numeric,
  add column if not exists terrace_area_sqft numeric,
  add column if not exists covered_terrace_area_sqft numeric,
  add column if not exists terrace_area_raw_text text,
  add column if not exists frontage_ft numeric,
  add column if not exists entrance_count integer,
  add column if not exists otla_area_sqft numeric,
  add column if not exists otla_area_raw_text text,
  add column if not exists heritage_space boolean,
  add column if not exists permitted_use_types text[] default '{}',
  add column if not exists ideal_for text,
  add column if not exists automatic_shutter_count integer,
  add column if not exists room_count integer,
  add column if not exists suite_count integer,
  add column if not exists banquet_hall_count integer,
  add column if not exists restaurant_count integer,
  add column if not exists bar_facility boolean,
  add column if not exists operational_status text,
  add column if not exists rent_inclusions text,
  add column if not exists license_type text,
  add column if not exists short_term_allowed boolean,
  add column if not exists inspection_notice_minutes integer,
  add column if not exists director_cabin_count integer,
  add column if not exists ceo_cabin_present boolean,
  add column if not exists cubicle_count integer,
  add column if not exists conference_room_capacity integer,
  add column if not exists meeting_room_capacity integer,
  add column if not exists training_room_capacity integer,
  add column if not exists cafeteria_seat_count integer,
  add column if not exists accounts_area boolean,
  add column if not exists lounge_area boolean,
  add column if not exists price_math jsonb default '{}'::jsonb;

-- Broker RERA is distinct from a property's/project's RERA number.
alter table public.residential_sale_listings add column if not exists broker_rera_number text;
alter table public.residential_rent_listings add column if not exists broker_rera_number text;
alter table public.commercial_sale_listings add column if not exists broker_rera_number text;
alter table public.commercial_rent_listings add column if not exists broker_rera_number text;

create index if not exists idx_commercial_rent_broker_rera
  on public.commercial_rent_listings (broker_rera_number)
  where broker_rera_number is not null;

commit;
