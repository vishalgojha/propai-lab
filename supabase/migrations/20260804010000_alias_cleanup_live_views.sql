-- Replace temporary snapshot tables with explicit live read-model views.
-- The three typed_* objects are tables in the deployed project, so they are
-- removed only after application reads have moved to the live typed tables.
begin;

drop table if exists public.typed_parsed_output;
drop table if exists public.typed_listings_index;
drop table if exists public.typed_market_requirements;

drop view if exists public.listings_unified;

create view public.listings_unified
with (security_invoker = true)
as
select
  'residential_sale'::text as card_type,
  id,
  raw_message_id,
  tenant_id,
  building_name,
  micro_market,
  broker_name,
  broker_phone,
  bhk::text as bhk,
  carpet_area_sqft as area_sqft,
  total_asking_price as price,
  'sale'::text as transaction_type,
  needs_review,
  created_at
from public.residential_sale_listings
union all
select
  'residential_rent'::text as card_type,
  id,
  raw_message_id,
  tenant_id,
  building_name,
  micro_market,
  broker_name,
  broker_phone,
  bhk::text as bhk,
  carpet_area_sqft as area_sqft,
  monthly_rent as price,
  'rent'::text as transaction_type,
  needs_review,
  created_at
from public.residential_rent_listings
union all
select
  'commercial_sale'::text as card_type,
  id,
  raw_message_id,
  tenant_id,
  building_name,
  micro_market,
  broker_name,
  broker_phone,
  null::text as bhk,
  carpet_area_sqft as area_sqft,
  total_asking_price as price,
  'sale'::text as transaction_type,
  needs_review,
  created_at
from public.commercial_sale_listings
union all
select
  'commercial_rent'::text as card_type,
  id,
  raw_message_id,
  tenant_id,
  building_name,
  micro_market,
  broker_name,
  broker_phone,
  null::text as bhk,
  carpet_area_sqft as area_sqft,
  monthly_rent as price,
  'rent'::text as transaction_type,
  needs_review,
  created_at
from public.commercial_rent_listings;

alter view public.parsed_output_unified set (security_invoker = true);
alter view public.requirements_unified set (security_invoker = true);

grant select on public.parsed_output_unified to anon, authenticated, service_role;
grant select on public.listings_unified to anon, authenticated, service_role;
grant select on public.requirements_unified to anon, authenticated, service_role;

notify pgrst, 'reload schema';
commit;
