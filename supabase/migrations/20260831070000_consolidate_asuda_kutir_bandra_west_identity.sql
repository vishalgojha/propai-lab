-- Asuda Kutir is the same Bandra West property referenced from both
-- Waterfield Road and Mount Mary Road. Preserve source text and typed rows.
delete from public.building_name_aliases
 where lower(trim(alias)) in (
   'asuda kutir',
   '"asuda kutir"',
   'asuda kutir mount mary',
   'asuda kutir waterfield road'
 );

insert into public.building_name_aliases
  (building_id, alias, canonical_name, confidence, source)
values
  (10267, 'Asuda Kutir', 'Asuda Kutir', 0.99, 'official_identity_review'),
  (10267, 'ASUDA KUTIR', 'Asuda Kutir', 0.99, 'official_identity_review'),
  (10267, '"ASUDA KUTIR"', 'Asuda Kutir', 0.99, 'official_identity_review'),
  (10267, 'Asuda Kutir Mount Mary', 'Asuda Kutir', 0.99, 'official_identity_review'),
  (10267, 'Asuda Kutir Waterfield Road', 'Asuda Kutir', 0.99, 'official_identity_review');

update public.residential_rent_listings l
   set building_id = 10267,
       micro_market = coalesce(l.micro_market, 'Bandra West')
 where lower(coalesce(l.building_name,'')) like '%asuda kutir%'
   and (l.building_id = 19605 or l.building_id is null)
   and exists (
     select 1
       from public.raw_messages rm
      where rm.id = l.raw_message_id
        and lower(rm.message) like '%asuda kutir%'
        and (
          lower(rm.message) like '%waterfield%'
          or lower(rm.message) like '%mount mary%'
          or lower(rm.message) like '%bandra west%'
        )
   );

select public.refresh_building_identity_review_queue();
