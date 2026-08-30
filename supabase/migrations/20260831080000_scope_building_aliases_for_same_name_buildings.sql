-- The same observed name may legitimately belong to multiple buildings.
-- Alias identity must therefore be scoped to the building, not globally unique.
alter table public.building_name_aliases
  drop constraint if exists building_name_aliases_alias_key;

alter table public.building_name_aliases
  add column if not exists locality_context text not null default '',
  add column if not exists address_context text not null default '';

create index if not exists idx_building_name_aliases_normalized
  on public.building_name_aliases (lower(trim(alias)));

create index if not exists idx_building_name_aliases_building_alias
  on public.building_name_aliases (building_id, lower(trim(alias)));

delete from public.building_name_aliases
 where building_id = 10267
   and lower(trim(alias)) in ('asuda kutir mount mary');

insert into public.building_name_aliases
  (building_id, alias, canonical_name, confidence, source, locality_context, address_context)
values
  (10267, 'Asuda Kutir', 'Asuda Kutir', 0.99, 'official_identity_review', 'Bandra West', 'Waterfield Road'),
  (10267, 'ASUDA KUTIR', 'Asuda Kutir', 0.99, 'official_identity_review', 'Bandra West', 'Waterfield Road'),
  (10267, '"ASUDA KUTIR"', 'Asuda Kutir', 0.99, 'official_identity_review', 'Bandra West', 'Waterfield Road'),
  (16942, 'Asuda Kutir', 'Asuda Kutir', 0.99, 'official_identity_review', 'Bandra West', 'Mount Mary Road'),
  (16942, 'ASUDA KUTIR', 'Asuda Kutir', 0.99, 'official_identity_review', 'Bandra West', 'Mount Mary Road'),
  (16942, '"ASUDA KUTIR"', 'Asuda Kutir', 0.99, 'official_identity_review', 'Bandra West', 'Mount Mary Road');

select public.refresh_building_identity_review_queue();
