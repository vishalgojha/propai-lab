update public.residential_rent_listings l
   set building_id = 17469,
       micro_market = 'Bandra East'
 where lower(coalesce(l.building_name,'')) like '%ten bkc%'
   and exists (
     select 1
       from public.raw_messages rm
      where rm.id = l.raw_message_id
        and lower(rm.message) like '%bandra%'
        and lower(rm.message) like '%bkc%'
   )
   and l.building_id is distinct from 17469;

select public.refresh_building_identity_review_queue();
