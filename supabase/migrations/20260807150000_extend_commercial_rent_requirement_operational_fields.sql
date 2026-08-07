-- Commercial-rent demand fields for operational, access, and budget constraints.
begin;

alter table public.commercial_rent_requirements
  add column if not exists floor_count_max integer,
  add column if not exists consecutive_floors_required boolean,
  add column if not exists entrance_requirement text,
  add column if not exists signage_required boolean,
  add column if not exists loading_access_required boolean,
  add column if not exists power_requirements text,
  add column if not exists budget_includes_maintenance boolean;

create index if not exists idx_commercial_rent_requirements_locality
  on public.commercial_rent_requirements using gin (locality_options);

commit;
