-- Commercial-sale extraction schema. Additive and nullable for historical rows.
begin;

alter table public.commercial_sale_listings
  add column if not exists terrace_area_sqft numeric,
  add column if not exists covered_terrace_area_sqft numeric,
  add column if not exists terrace_area_raw_text text,
  add column if not exists frontage_ft numeric,
  add column if not exists entrance_count integer,
  add column if not exists permitted_use_types text[] default '{}',
  add column if not exists ideal_for text,
  add column if not exists project_inventory boolean default false,
  add column if not exists area_min_sqft numeric,
  add column if not exists area_max_sqft numeric,
  add column if not exists floor_plate_sqft numeric,
  add column if not exists project_status text,
  add column if not exists director_cabin_count integer,
  add column if not exists ceo_cabin_present boolean,
  add column if not exists cubicle_count integer,
  add column if not exists conference_room_capacity integer,
  add column if not exists meeting_room_capacity integer,
  add column if not exists reception_area boolean default false,
  add column if not exists server_room boolean default false,
  add column if not exists storage_area boolean default false,
  add column if not exists inspection_notice_minutes integer,
  add column if not exists price_math jsonb default '{}'::jsonb;

create index if not exists idx_commercial_sale_project_inventory
  on public.commercial_sale_listings (project_inventory)
  where project_inventory = true;

commit;
