-- Commercial-rent demand fields captured from broker requirement messages.
begin;

alter table public.commercial_rent_requirements
  add column if not exists intended_use_details text,
  add column if not exists area_basis_preference text,
  add column if not exists location_flexibility text,
  add column if not exists floor_min integer,
  add column if not exists floor_max integer,
  add column if not exists floor_preference text,
  add column if not exists parking_required boolean,
  add column if not exists needs_attached_washroom boolean,
  add column if not exists needs_washroom boolean,
  add column if not exists needs_pantry boolean default false,
  add column if not exists premium_building_required boolean,
  add column if not exists glass_facade_required boolean,
  add column if not exists residential_cum_commercial_ok boolean,
  add column if not exists by_lanes_accepted boolean,
  add column if not exists media_requested boolean,
  add column if not exists brokerage_context text,
  add column if not exists brokerage_terms_raw text,
  add column if not exists contacts jsonb default '[]'::jsonb,
  add column if not exists urgency text,
  add column if not exists min_washroom_count integer;

create index if not exists idx_commercial_rent_requirements_budget
  on public.commercial_rent_requirements (budget_max);

commit;
