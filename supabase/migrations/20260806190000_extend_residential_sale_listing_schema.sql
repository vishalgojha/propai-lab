-- Extend residential sale listings for broker-grade WhatsApp evidence.
-- Additive only: no existing columns or data are removed.

alter table public.residential_sale_listings
  add column if not exists broker_company text,
  add column if not exists contacts jsonb default '[]'::jsonb,
  add column if not exists showing_instructions text,
  add column if not exists contact_instructions text,

  add column if not exists availability_status text,
  add column if not exists brokerage_context text,
  add column if not exists co_brokered boolean,

  add column if not exists wing text,
  add column if not exists floor_min integer,
  add column if not exists floor_max integer,
  add column if not exists floor_label text,

  add column if not exists original_bhk numeric,
  add column if not exists current_bhk numeric,
  add column if not exists is_converted_unit boolean,
  add column if not exists is_combination_unit boolean,
  add column if not exists configuration_details text,
  add column if not exists can_sell_separately boolean,

  add column if not exists balcony_area_sqft numeric,
  add column if not exists balcony_area_raw_text text,
  add column if not exists terrace_area_sqft numeric,
  add column if not exists covered_terrace_area_sqft numeric,
  add column if not exists terrace_area_raw_text text,
  add column if not exists sellable_area_sqft numeric,

  add column if not exists computed_total_asking_price numeric,
  add column if not exists computed_price_confidence text,
  add column if not exists price_math jsonb default '{}'::jsonb,

  add column if not exists unit_condition text,
  add column if not exists vastu_compliant boolean,
  add column if not exists view_description text,
  add column if not exists parking_details jsonb default '{}'::jsonb,

  add column if not exists society_restrictions_raw text,
  add column if not exists unstructured_facts jsonb default '{}'::jsonb;

create index if not exists idx_residential_sale_listings_wing
  on public.residential_sale_listings (tenant_id, building_name, wing)
  where wing is not null;

create index if not exists idx_residential_sale_listings_contacts_gin
  on public.residential_sale_listings using gin (contacts);

create index if not exists idx_residential_sale_listings_unstructured_facts_gin
  on public.residential_sale_listings using gin (unstructured_facts);
