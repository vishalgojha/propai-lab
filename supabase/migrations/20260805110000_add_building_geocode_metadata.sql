alter table public.buildings
  add column if not exists plus_code text,
  add column if not exists geocode_query text,
  add column if not exists geocode_source text,
  add column if not exists geocode_confidence numeric,
  add column if not exists geocoded_at timestamptz;

create index if not exists idx_buildings_plus_code
  on public.buildings (plus_code)
  where plus_code is not null;
