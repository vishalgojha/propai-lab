-- Residential rental listings need to preserve the richer facts brokers use
-- in WhatsApp broadcasts without changing the existing rent/tenant model.
begin;

alter table public.residential_rent_listings
  add column if not exists original_bhk numeric,
  add column if not exists current_bhk numeric,
  add column if not exists configuration_details text,
  add column if not exists is_converted_unit boolean,
  add column if not exists is_combination_unit boolean,
  add column if not exists balcony_present boolean,
  add column if not exists balcony_area_sqft numeric,
  add column if not exists balcony_area_raw_text text,
  add column if not exists terrace_area_sqft numeric,
  add column if not exists covered_terrace_area_sqft numeric,
  add column if not exists terrace_area_raw_text text,
  add column if not exists sit_out_present boolean,
  add column if not exists unit_condition text,
  add column if not exists availability_status text,
  add column if not exists availability_date_raw text,
  add column if not exists wing text,
  add column if not exists floor_min integer,
  add column if not exists floor_max integer,
  add column if not exists floor_label text,
  add column if not exists parking_details jsonb default '{}'::jsonb,
  add column if not exists has_lift boolean,
  add column if not exists view_description text,
  add column if not exists society_restrictions_raw text,
  add column if not exists broker_company text,
  add column if not exists contacts jsonb default '[]'::jsonb,
  add column if not exists showing_instructions text,
  add column if not exists contact_instructions text,
  add column if not exists brokerage_context text,
  add column if not exists brokerage_terms_raw text,
  add column if not exists plus_one_deal boolean,
  add column if not exists fee_sharing_required boolean,
  add column if not exists client_profile_required boolean,
  add column if not exists unstructured_facts jsonb default '{}'::jsonb,
  add column if not exists lease_term_min_months integer,
  add column if not exists lease_term_max_months integer,
  add column if not exists lease_term_raw_text text;

create index if not exists idx_residential_rent_listings_availability
  on public.residential_rent_listings (availability_status);

commit;
