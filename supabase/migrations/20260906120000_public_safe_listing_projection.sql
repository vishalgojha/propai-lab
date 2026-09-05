-- Replace the anonymous listing projection with a buyer-facing shape.
-- Keep the old relation private for rollback/inspection without granting it to
-- public roles. No existing production rows are updated by this migration.
alter view public.listings_unified_public rename to listings_unified_public_legacy;
revoke all on public.listings_unified_public_legacy from anon, authenticated;

create view public.listings_unified_public as
select
  card_type, id, building_name, micro_market, bhk, area_sqft, price,
  price_unit, price_model, price_per_sqft, price_raw_text, price_qualifier,
  furnishing, furnishing_status, fitout_status, floor_description,
  view, property_view, location_label, locality_raw, locality_resolved,
  locality_confidence, landmark_name, street_name, summary_title,
  deal_tags, additional_charges, needs_review, created_at, updated_at,
  first_seen, last_seen, observation_count, group_count,
  representative_listing_index, canonical_micro_market_slug,
  source_fingerprint, asset_type, property_type, intent, transaction_type,
  transaction_nature, broker_id, fingerprint, developer, orientation,
  listing_source, location_raw, opportunity_key, broker_name
from public.listings_unified_public_legacy;

grant select on public.listings_unified_public to anon, authenticated;
notify pgrst, 'reload schema';
