-- Expose canonical repost identity to public read paths. Typed tables retain
-- every source observation; public surfaces select the latest row per key.
drop view if exists public.listings_unified_public;

create view public.listings_unified_public
with (security_invoker = true)
as
select v.*, r.opportunity_key
from public.listings_unified v
left join public.residential_sale_listings r on v.id = r.id
where v.card_type = 'residential_sale'
union all
select v.*, r.opportunity_key
from public.listings_unified v
left join public.residential_rent_listings r on v.id = r.id
where v.card_type = 'residential_rent'
union all
select v.*, r.opportunity_key
from public.listings_unified v
left join public.commercial_sale_listings r on v.id = r.id
where v.card_type = 'commercial_sale'
union all
select v.*, r.opportunity_key
from public.listings_unified v
left join public.commercial_rent_listings r on v.id = r.id
where v.card_type = 'commercial_rent';

grant select on public.listings_unified_public to anon, authenticated;
notify pgrst, 'reload schema';
