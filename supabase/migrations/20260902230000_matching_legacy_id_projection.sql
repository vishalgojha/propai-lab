-- Typed read-model IDs are local to each typed table and can collide. The
-- legacy-compatible requirement_matches table instead references globally
-- keyed legacy rows. Keep public typed IDs unchanged and expose an internal
-- FK-compatible matching_id for the matcher only.

drop view if exists public.requirements_unified_matching;
create view public.requirements_unified_matching with (security_invoker = true) as
select v.*, r.legacy_source_id as matching_id
from public.requirements_unified v
join public.residential_sale_requirements r on v.req_type = 'residential_sale' and v.id = r.id
union all
select v.*, r.legacy_source_id as matching_id
from public.requirements_unified v
join public.residential_rent_requirements r on v.req_type = 'residential_rent' and v.id = r.id
union all
select v.*, r.legacy_source_id as matching_id
from public.requirements_unified v
join public.commercial_sale_requirements r on v.req_type = 'commercial_sale' and v.id = r.id
union all
select v.*, r.legacy_source_id as matching_id
from public.requirements_unified v
join public.commercial_rent_requirements r on v.req_type = 'commercial_rent' and v.id = r.id;

drop view if exists public.listings_unified_matching;
create view public.listings_unified_matching with (security_invoker = true) as
select v.*, r.legacy_source_id as matching_id
from public.listings_unified v
join public.residential_sale_listings r on v.card_type = 'residential_sale' and v.id = r.id
union all
select v.*, r.legacy_source_id as matching_id
from public.listings_unified v
join public.residential_rent_listings r on v.card_type = 'residential_rent' and v.id = r.id
union all
select v.*, r.legacy_source_id as matching_id
from public.listings_unified v
join public.commercial_sale_listings r on v.card_type = 'commercial_sale' and v.id = r.id
union all
select v.*, r.legacy_source_id as matching_id
from public.listings_unified v
join public.commercial_rent_listings r on v.card_type = 'commercial_rent' and v.id = r.id;

comment on view public.requirements_unified_matching is
  'Internal matcher projection: typed requirement fields plus legacy_source_id as matching_id.';
comment on view public.listings_unified_matching is
  'Internal matcher projection: typed listing fields plus legacy_source_id as matching_id.';
