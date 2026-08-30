-- Keep building identity available to server-side public pages without
-- exposing it in the privacy-shaped listings_unified_public projection.
drop view if exists public.listings_by_building_public;
create view public.listings_by_building_public
with (security_invoker = true)
as
select id, 'residential_sale'::text as card_type, building_id
from public.residential_sale_listings
where building_id is not null
union all
select id, 'residential_rent'::text, building_id
from public.residential_rent_listings
where building_id is not null
union all
select id, 'commercial_sale'::text, building_id
from public.commercial_sale_listings
where building_id is not null
union all
select id, 'commercial_rent'::text, building_id
from public.commercial_rent_listings
where building_id is not null;

grant select on public.listings_by_building_public to anon, authenticated;
notify pgrst, 'reload schema';
