-- Ten BKC and X BKC are the same verified project. Keep one enriched
-- registry identity and retain every original listing/source message.
delete from public.building_name_aliases
 where lower(trim(alias)) in (
   'x bkc','xbkc','bkc-x','ten bkc','ten bkc kalanagar',
   'adani ten bkc','ten (x) bkc by adani realty'
 );

insert into public.building_name_aliases
  (building_id, alias, canonical_name, confidence, source)
values
  (17469, 'Ten BKC', 'Ten Bkc', 0.99, 'official_identity_review'),
  (17469, 'X BKC', 'Ten Bkc', 0.99, 'official_identity_review'),
  (17469, 'Xbkc', 'Ten Bkc', 0.99, 'official_identity_review'),
  (17469, 'BKC-X', 'Ten Bkc', 0.99, 'official_identity_review'),
  (17469, 'Ten BKC Kalanagar', 'Ten Bkc', 0.99, 'official_identity_review'),
  (17469, 'Adani Ten BKC', 'Ten Bkc', 0.99, 'official_identity_review'),
  (17469, 'Ten (X) BKC By Adani Realty', 'Ten Bkc', 0.99, 'official_identity_review');

update public.residential_rent_listings l
   set building_id = 17469,
       micro_market = 'Bandra East'
 where lower(coalesce(l.building_name,'')) like '%ten bkc%'
   and exists (
     select 1 from public.raw_messages rm
      where rm.id = l.raw_message_id
        and lower(rm.message) like '%bandra%'
        and lower(rm.message) like '%bkc%'
   )
   and l.building_id is distinct from 17469;

update public.residential_sale_listings
   set building_id = 17469,
       micro_market = coalesce(micro_market, 'Bandra East')
 where (
       lower(coalesce(building_name,'')) like '%xbkc%'
       or lower(coalesce(building_name,'')) like '%adani ten bkc%'
       or lower(coalesce(building_name,'')) like '%bkc-x%'
      )
   and building_id in (18961, 21002);

select public.refresh_building_identity_review_queue();
