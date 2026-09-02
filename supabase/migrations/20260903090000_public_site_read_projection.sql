-- Public www reads must use owner-secured, privacy-shaped projections.
-- `security_invoker` on the previous views caused anonymous requests to inherit
-- the service-role-only policies of the underlying typed tables, producing
-- empty public pages even though inventory existed.

alter view public.listings_unified_public set (security_invoker = false);

grant select on public.listings_unified_public to anon, authenticated;

alter view public.listings_by_building_public set (security_invoker = false);

grant select on public.listings_by_building_public to anon, authenticated;

drop view if exists public.buildings_public;
create view public.buildings_public as
select id, canonical_name, micro_market, latitude, longitude, address,
       developer, enrichment_confidence, geocode_source, geocode_confidence
from public.buildings
where canonical_name is not null and trim(canonical_name) <> '';

grant select on public.buildings_public to anon, authenticated;

drop view if exists public.building_aliases_public;
create view public.building_aliases_public as
select building_id, alias, canonical_name
from public.building_name_aliases
where alias is not null and trim(alias) <> '';

grant select on public.building_aliases_public to anon, authenticated;

-- These aggregates are intentionally bounded public metrics, not a raw data
-- interface. Run them as the function owner so protected base tables do not
-- turn valid counts into anonymous zeroes.
alter function public.get_public_counts() security definer;
alter function public.get_locality_counts() security definer;
alter function public.get_public_counts() set search_path = public, pg_temp;
alter function public.get_locality_counts() set search_path = public, pg_temp;

notify pgrst, 'reload schema';
