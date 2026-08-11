-- Remove one broker footer that was incorrectly persisted as a building.
-- The source WhatsApp message remains intact; only the derived bad field and
-- derived building/enrichment records are corrected.

update public.residential_rent_listings
   set building_name = null,
       needs_review = true,
       validation_flags = coalesce(validation_flags, '[]'::jsonb)
         || '["building_name_is_broker_signature","building_name_unresolved"]'::jsonb,
       updated_at = now()
 where raw_message_id = 506406
   and lower(coalesce(building_name, '')) = 'harkirat singh';

delete from public.building_enrichment_history
 where building_id in (
   select id from public.buildings
    where lower(canonical_name) = 'harkirat singh'
      and google_place_id is null
 );

delete from public.building_enrichment_sources
 where building_id in (
   select id from public.buildings
    where lower(canonical_name) = 'harkirat singh'
      and google_place_id is null
 );

delete from public.building_enrichment_jobs
 where building_id in (
   select id from public.buildings
    where lower(canonical_name) = 'harkirat singh'
      and google_place_id is null
 );

delete from public.building_name_aliases
 where building_id in (
   select id from public.buildings
    where lower(canonical_name) = 'harkirat singh'
      and google_place_id is null
 );

delete from public.buildings
 where lower(canonical_name) = 'harkirat singh'
   and google_place_id is null;

insert into public.data_quality_backfill_runs(run_name, details)
values (
  'remove_broker_signature_building_20260811',
  jsonb_build_object(
    'raw_message_id', 506406,
    'reason', 'broker footer was incorrectly persisted as a building',
    'applied_at', now()
  )
);
