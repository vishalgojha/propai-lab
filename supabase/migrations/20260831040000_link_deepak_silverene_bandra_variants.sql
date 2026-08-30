-- Link the confirmed Bandra West spelling variants to the verified building.
-- This is identity repair, not listing deduplication: each opportunity row is
-- retained and the separate Dadar-looking record is deliberately untouched.
do $$
declare
  target_id bigint;
begin
  select b.id into target_id
  from public.buildings b
  where lower(trim(b.canonical_name)) = 'deepak silverene'
    and lower(trim(b.micro_market)) = 'bandra west'
    and lower(coalesce(b.address, '')) like '%hill rd%'
  order by b.enrichment_confidence desc nulls last, b.id
  limit 1;

  if target_id is null then
    raise exception 'Verified Deepak Silverene Bandra West building was not found';
  end if;

  insert into public.building_name_aliases
    (building_id, alias, canonical_name, confidence, source)
  select target_id, v.alias, 'Deepak Silverene', v.confidence, 'reviewed_context'
  from (values
    ('Deepak Silverline', 0.96::numeric),
    ('Deepak Silverine', 0.96::numeric)
  ) as v(alias, confidence)
  where not exists (
    select 1 from public.building_name_aliases a where lower(trim(a.alias)) = lower(trim(v.alias))
  );

  update public.residential_rent_listings
  set building_id = target_id
  where lower(trim(building_name)) in ('deepak silverene', 'deepak silverline', 'deepak silverine')
    and lower(trim(micro_market)) = 'bandra west';

  update public.residential_sale_listings
  set building_id = target_id
  where lower(trim(building_name)) in ('deepak silverene', 'deepak silverline', 'deepak silverine')
    and lower(trim(micro_market)) = 'bandra west';
end $$;
