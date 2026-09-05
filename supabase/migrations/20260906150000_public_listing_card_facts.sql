-- Add source-grounded facts used by homepage listing cards. Contact details
-- and raw message evidence remain outside this public projection.
drop view if exists public.listings_unified_public;

create view public.listings_unified_public as
select
  l.*,
  case
    when l.card_type = 'residential_sale' then (select r.bathroom_count from public.residential_sale_listings r where r.id = l.id)
    when l.card_type = 'residential_rent' then (select r.bathroom_count from public.residential_rent_listings r where r.id = l.id)
    else null
  end as bathroom_count,
  case
    when l.card_type = 'residential_sale' then (select r.car_parking_count from public.residential_sale_listings r where r.id = l.id)
    when l.card_type = 'residential_rent' then (select r.car_parking_count from public.residential_rent_listings r where r.id = l.id)
    when l.card_type = 'commercial_sale' then (select r.car_parking_count from public.commercial_sale_listings r where r.id = l.id)
    when l.card_type = 'commercial_rent' then (select r.car_parking_count from public.commercial_rent_listings r where r.id = l.id)
    else null
  end as car_parking_count,
  case
    when l.card_type = 'residential_sale' then (select r.parking_type from public.residential_sale_listings r where r.id = l.id)
    when l.card_type = 'residential_rent' then (select r.parking_type from public.residential_rent_listings r where r.id = l.id)
    when l.card_type = 'commercial_sale' then (select r.parking_type from public.commercial_sale_listings r where r.id = l.id)
    when l.card_type = 'commercial_rent' then (select r.parking_type from public.commercial_rent_listings r where r.id = l.id)
    else null
  end as parking_type,
  case
    when l.card_type = 'commercial_sale' then (select r.has_lift from public.commercial_sale_listings r where r.id = l.id)
    when l.card_type = 'commercial_rent' then (select r.has_lift from public.commercial_rent_listings r where r.id = l.id)
    else null
  end as has_lift,
  case
    when l.card_type = 'commercial_sale' then (select r.has_power_backup from public.commercial_sale_listings r where r.id = l.id)
    when l.card_type = 'commercial_rent' then (select r.has_power_backup from public.commercial_rent_listings r where r.id = l.id)
    else null
  end as has_power_backup
from public.listings_unified_public_legacy l;

grant select on public.listings_unified_public to anon, authenticated;
notify pgrst, 'reload schema';
