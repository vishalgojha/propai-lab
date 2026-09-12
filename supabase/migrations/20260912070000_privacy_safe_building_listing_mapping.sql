-- Public building pages need the immutable typed-table building_id link, but
-- must not expose typed rows that are outside the buyer-facing projection.
-- Keep this view owner-secured and use the public projection as the allowlist.
drop view if exists public.listings_by_building_public;

create view public.listings_by_building_public
with (security_invoker = false)
as
select p.id, p.card_type, r.building_id
from public.listings_unified_public p
join public.residential_sale_listings r on r.id = p.id
where p.card_type = 'residential_sale'
  and r.building_id is not null
union all
select p.id, p.card_type, r.building_id
from public.listings_unified_public p
join public.residential_rent_listings r on r.id = p.id
where p.card_type = 'residential_rent'
  and r.building_id is not null
union all
select p.id, p.card_type, r.building_id
from public.listings_unified_public p
join public.commercial_sale_listings r on r.id = p.id
where p.card_type = 'commercial_sale'
  and r.building_id is not null
union all
select p.id, p.card_type, r.building_id
from public.listings_unified_public p
join public.commercial_rent_listings r on r.id = p.id
where p.card_type = 'commercial_rent'
  and r.building_id is not null;

grant select on public.listings_by_building_public to anon, authenticated;
notify pgrst, 'reload schema';
