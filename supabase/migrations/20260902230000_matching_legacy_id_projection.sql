-- Typed read-model IDs are local to each typed table and can collide. The
-- matching table therefore stores the typed table discriminator alongside
-- each typed ID. Legacy IDs remain nullable compatibility fields only.

alter table public.requirement_matches
  alter column requirement_id drop not null,
  alter column listing_id drop not null;

alter table public.requirement_matches
  drop constraint if exists requirement_matches_requirement_id_fkey,
  drop constraint if exists requirement_matches_listing_id_fkey,
  drop constraint if exists requirement_matches_requirement_id_listing_id_key;

alter table public.requirement_matches
  add column if not exists requirement_type text,
  add column if not exists requirement_typed_id bigint,
  add column if not exists listing_type text,
  add column if not exists listing_typed_id bigint;

create unique index if not exists requirement_matches_typed_pair_key
  on public.requirement_matches (
    tenant_id, requirement_type, requirement_typed_id,
    listing_type, listing_typed_id
  );

create index if not exists requirement_matches_typed_requirement_idx
  on public.requirement_matches (tenant_id, requirement_type, requirement_typed_id, match_score desc);

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
  'Internal matcher projection: typed requirement fields plus optional legacy_source_id.';
comment on view public.listings_unified_matching is
  'Internal matcher projection: typed listing fields plus optional legacy_source_id.';
