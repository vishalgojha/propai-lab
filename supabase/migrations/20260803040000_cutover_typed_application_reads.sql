-- Application read models for the typed extraction schema.
--
-- The eight typed tables are the source of truth.  These views are read-only
-- compatibility-shaped projections for code paths that still need the old
-- flat field vocabulary while they are being migrated.  They deliberately
-- have new names: the deprecated relation names are not recreated.

begin;

create or replace view public.typed_parsed_output
with (security_invoker = true)
as
select (jsonb_populate_record(null::public.parsed_output_legacy,
  to_jsonb(r) || jsonb_build_object(
    'id', coalesce(r.legacy_source_id, r.id),
    'message_type', 'LISTING',
    'intent', upper(r.transaction_type),
    'bhk', r.bhk::text,
    'location_raw', coalesce(r.locality_raw, r.locality_resolved, r.micro_market),
    'price', r.total_asking_price,
    'price_unit', 'abs',
    'price_per_sqft', r.price_per_sqft,
    'area_sqft', r.carpet_area_sqft,
    'furnishing', r.furnishing_status,
    'furnishing_canonical', r.furnishing_status,
    'micro_market', coalesce(r.micro_market, r.locality_resolved),
    'needs_review', r.needs_review,
    'normalized_message', r.normalized_message
  ))).* from public.residential_sale_listings r
union all
select (jsonb_populate_record(null::public.parsed_output_legacy,
  to_jsonb(r) || jsonb_build_object(
    'id', coalesce(r.legacy_source_id, r.id),
    'message_type', 'LISTING',
    'intent', upper(r.transaction_type),
    'bhk', r.bhk::text,
    'location_raw', coalesce(r.locality_raw, r.locality_resolved, r.micro_market),
    'price', r.monthly_rent,
    'price_unit', 'abs',
    'price_per_sqft', r.rent_per_sqft,
    'area_sqft', r.carpet_area_sqft,
    'furnishing', r.furnishing_status,
    'furnishing_canonical', r.furnishing_status,
    'micro_market', coalesce(r.micro_market, r.locality_resolved),
    'needs_review', r.needs_review,
    'normalized_message', r.normalized_message
  ))).* from public.residential_rent_listings r
union all
select (jsonb_populate_record(null::public.parsed_output_legacy,
  to_jsonb(r) || jsonb_build_object(
    'id', coalesce(r.legacy_source_id, r.id),
    'message_type', 'LISTING',
    'intent', upper(r.transaction_type),
    'location_raw', coalesce(r.locality_raw, r.locality_resolved, r.micro_market),
    'price', r.total_asking_price,
    'price_unit', 'abs',
    'price_per_sqft', r.price_per_sqft,
    'area_sqft', r.carpet_area_sqft,
    'furnishing', r.fitout_status,
    'furnishing_canonical', r.fitout_status,
    'micro_market', coalesce(r.micro_market, r.locality_resolved),
    'needs_review', r.needs_review,
    'normalized_message', r.normalized_message
  ))).* from public.commercial_sale_listings r
union all
select (jsonb_populate_record(null::public.parsed_output_legacy,
  to_jsonb(r) || jsonb_build_object(
    'id', coalesce(r.legacy_source_id, r.id),
    'message_type', 'LISTING',
    'intent', upper(r.transaction_type),
    'location_raw', coalesce(r.locality_raw, r.locality_resolved, r.micro_market),
    'price', r.monthly_rent,
    'price_unit', 'abs',
    'price_per_sqft', r.rent_per_sqft,
    'area_sqft', r.carpet_area_sqft,
    'furnishing', r.fitout_status,
    'furnishing_canonical', r.fitout_status,
    'micro_market', coalesce(r.micro_market, r.locality_resolved),
    'needs_review', r.needs_review,
    'normalized_message', r.normalized_message
  ))).* from public.commercial_rent_listings r
union all
select (jsonb_populate_record(null::public.parsed_output_legacy,
  to_jsonb(r) || jsonb_build_object(
    'id', coalesce(r.legacy_source_id, r.id),
    'message_type', 'REQUIREMENT',
    'intent', 'BUY',
    'bhk', case when cardinality(r.bhk_options) > 0 then r.bhk_options[1]::text end,
    'location_raw', coalesce(r.locality_raw, r.locality_resolved, r.micro_market),
    'price', r.budget_max,
    'price_unit', 'abs',
    'area_sqft', coalesce(r.carpet_area_max_sqft, r.area_max_sqft),
    'micro_market', coalesce(r.micro_market, r.locality_resolved),
    'needs_review', r.needs_review,
    'normalized_message', r.normalized_message
  ))).* from public.residential_sale_requirements r
union all
select (jsonb_populate_record(null::public.parsed_output_legacy,
  to_jsonb(r) || jsonb_build_object(
    'id', coalesce(r.legacy_source_id, r.id),
    'message_type', 'REQUIREMENT',
    'intent', 'BUY',
    'bhk', case when cardinality(r.bhk_options) > 0 then r.bhk_options[1]::text end,
    'location_raw', coalesce(r.locality_raw, r.locality_resolved, r.micro_market),
    'price', r.budget_max,
    'price_unit', 'abs',
    'area_sqft', coalesce(r.carpet_area_max_sqft, r.area_max_sqft),
    'micro_market', coalesce(r.micro_market, r.locality_resolved),
    'needs_review', r.needs_review,
    'normalized_message', r.normalized_message
  ))).* from public.residential_rent_requirements r
union all
select (jsonb_populate_record(null::public.parsed_output_legacy,
  to_jsonb(r) || jsonb_build_object(
    'id', coalesce(r.legacy_source_id, r.id),
    'message_type', 'REQUIREMENT',
    'intent', 'BUY',
    'location_raw', coalesce(r.locality_raw, r.locality_resolved, r.micro_market),
    'price', r.budget_max,
    'price_unit', 'abs',
    'area_sqft', coalesce(r.carpet_area_max_sqft, r.area_max_sqft),
    'micro_market', coalesce(r.micro_market, r.locality_resolved),
    'needs_review', r.needs_review,
    'normalized_message', r.normalized_message
  ))).* from public.commercial_sale_requirements r
union all
select (jsonb_populate_record(null::public.parsed_output_legacy,
  to_jsonb(r) || jsonb_build_object(
    'id', coalesce(r.legacy_source_id, r.id),
    'message_type', 'REQUIREMENT',
    'intent', 'BUY',
    'location_raw', coalesce(r.locality_raw, r.locality_resolved, r.micro_market),
    'price', r.budget_max,
    'price_unit', 'abs',
    'area_sqft', coalesce(r.carpet_area_max_sqft, r.area_max_sqft),
    'micro_market', coalesce(r.micro_market, r.locality_resolved),
    'needs_review', r.needs_review,
    'normalized_message', r.normalized_message
  ))).* from public.commercial_rent_requirements r;

create or replace view public.typed_listings_index
with (security_invoker = true)
as
select (jsonb_populate_record(null::public.listings_legacy,
  jsonb_build_object(
    'id', coalesce(r.legacy_source_id, r.id),
    'fingerprint', r.source_fingerprint,
    'intent', upper(r.transaction_type),
    'bhk', r.bhk::text,
    'price', r.total_asking_price,
    'price_unit', 'abs',
    'price_per_sqft', r.price_per_sqft,
    'area_sqft', r.carpet_area_sqft,
    'furnishing', r.furnishing_status,
    'location_label', coalesce(r.micro_market, r.locality_resolved, r.locality_raw),
    'building_name', r.building_name,
    'landmark_name', r.landmark_name,
    'micro_market', r.micro_market,
    'street_name', r.street_name,
    'developer', r.developer_name,
    'broker_name', r.broker_name,
    'broker_phone', r.broker_phone,
    'first_seen', r.created_at,
    'last_seen', r.updated_at,
    'observation_count', 1,
    'group_count', 1,
    'latest_raw_message_id', r.raw_message_id,
    'representative_raw_message_id', r.raw_message_id,
    'created_at', r.created_at,
    'updated_at', r.updated_at,
    'tenant_id', r.tenant_id,
    'asset_type', r.asset_type,
    'property_type', null,
    'transaction_type', r.transaction_type,
    'commercial_use_type', null,
    'fitout_status', null,
    'occupancy_type', r.occupancy_status,
    'deal_tags', r.deal_tags,
    'additional_charges', r.additional_charges) || jsonb_build_object(
    'carpet_area_sqft', r.carpet_area_sqft,
    'built_up_area_sqft', r.built_up_area_sqft,
    'bathroom_count', r.bathroom_count,
    'car_parking_count', r.car_parking_count,
    'parking_type', r.parking_type,
    'deposit_amount', null,
    'possession_date', r.possession_date,
    'possession_status', r.possession_status,
    'oc_status', r.oc_status,
    'interior_value', null,
    'ceiling_height', null,
    'price_basis', r.price_basis,
    'brokerage_type', r.brokerage_type,
    'configuration_type', r.configuration_type,
    'lease_term_type', null,
    'amenities', coalesce(r.unit_amenities, r.building_amenities),
    'amenities_unverified_claim', r.amenities_unverified_claim,
    'pet_policy', null,
    'tenant_type_preference', null,
    'sharing_allowed', null,
    'company_lease_criteria', null,
    'tenant_nationality_preference', null,
    'price_model', null,
    'canonical_micro_market_slug', null,
    'validation_flags', r.validation_flags,
    'needs_review', r.needs_review,
    'representative_listing_index', r.listing_index
  ))).* from public.residential_sale_listings r
union all
select (jsonb_populate_record(null::public.listings_legacy, jsonb_build_object(
  'id', coalesce(r.legacy_source_id, r.id), 'fingerprint', r.source_fingerprint,
  'intent', upper(r.transaction_type), 'bhk', r.bhk::text,
  'price', r.monthly_rent, 'price_unit', 'abs',
  'price_per_sqft', r.rent_per_sqft, 'area_sqft', r.carpet_area_sqft,
  'furnishing', r.furnishing_status,
  'location_label', coalesce(r.micro_market, r.locality_resolved, r.locality_raw),
  'building_name', r.building_name, 'landmark_name', r.landmark_name, 'micro_market', r.micro_market,
  'street_name', r.street_name, 'developer', null, 'broker_name', r.broker_name,
  'broker_phone', r.broker_phone, 'first_seen', r.created_at, 'last_seen', r.updated_at,
  'observation_count', 1, 'group_count', 1, 'latest_raw_message_id', r.raw_message_id,
  'representative_raw_message_id', r.raw_message_id, 'created_at', r.created_at, 'updated_at', r.updated_at,
  'tenant_id', r.tenant_id, 'asset_type', r.asset_type, 'property_type', null,
  'transaction_type', r.transaction_type, 'commercial_use_type', null,
  'fitout_status', null, 'occupancy_type', null, 'deal_tags', r.deal_tags,
  'additional_charges', r.additional_charges) || jsonb_build_object('carpet_area_sqft', r.carpet_area_sqft,
  'built_up_area_sqft', r.built_up_area_sqft, 'bathroom_count', r.bathroom_count,
  'car_parking_count', r.car_parking_count, 'parking_type', r.parking_type,
  'deposit_amount', r.deposit_amount, 'possession_date', null,
  'possession_status', r.possession_status, 'oc_status', null,
  'ceiling_height', null, 'price_basis', r.price_basis, 'brokerage_type', r.brokerage_type,
  'configuration_type', r.configuration_type, 'lease_term_type', r.lease_term_type,
  'amenities', coalesce(r.unit_amenities, r.building_amenities), 'amenities_unverified_claim', r.amenities_unverified_claim,
  'pet_policy', r.pet_policy, 'tenant_type_preference', r.tenant_type_preference,
  'sharing_allowed', r.sharing_allowed, 'company_lease_criteria', r.company_lease_criteria,
  'tenant_nationality_preference', r.tenant_nationality_preference, 'validation_flags', r.validation_flags,
  'needs_review', r.needs_review, 'representative_listing_index', r.listing_index
))).* from public.residential_rent_listings r
union all
select (jsonb_populate_record(null::public.listings_legacy, jsonb_build_object(
  'id', coalesce(r.legacy_source_id, r.id), 'fingerprint', r.source_fingerprint,
  'intent', upper(r.transaction_type), 'price', r.total_asking_price, 'price_unit', 'abs',
  'price_per_sqft', r.price_per_sqft, 'area_sqft', r.carpet_area_sqft,
  'furnishing', r.fitout_status, 'location_label', coalesce(r.micro_market, r.locality_resolved, r.locality_raw),
  'building_name', r.building_name, 'landmark_name', r.landmark_name, 'micro_market', r.micro_market, 'street_name', r.street_name,
  'developer', r.developer_name, 'broker_name', r.broker_name, 'broker_phone', r.broker_phone,
  'first_seen', r.created_at, 'last_seen', r.updated_at, 'observation_count', 1, 'group_count', 1,
  'latest_raw_message_id', r.raw_message_id, 'representative_raw_message_id', r.raw_message_id, 'created_at', r.created_at, 'updated_at', r.updated_at,
  'tenant_id', r.tenant_id, 'asset_type', r.asset_type, 'property_type', r.commercial_use_type, 'transaction_type', r.transaction_type,
  'commercial_use_type', r.commercial_use_type, 'fitout_status', r.fitout_status, 'occupancy_type', r.occupancy_status,
  'deal_tags', r.deal_tags, 'additional_charges', r.additional_charges, 'carpet_area_sqft', r.carpet_area_sqft, 'built_up_area_sqft', r.built_up_area_sqft,
  'car_parking_count', r.car_parking_count, 'parking_type', r.parking_type, 'possession_date', null,
  'possession_status', null, 'oc_status', null, 'ceiling_height', null, 'price_basis', r.price_basis,
  'brokerage_type', r.brokerage_type, 'lease_term_type', null, 'amenities', r.building_amenities,
  'amenities_unverified_claim', null, 'validation_flags', r.validation_flags, 'needs_review', r.needs_review, 'representative_listing_index', r.listing_index
))).* from public.commercial_sale_listings r
union all
select (jsonb_populate_record(null::public.listings_legacy, jsonb_build_object(
  'id', coalesce(r.legacy_source_id, r.id), 'fingerprint', r.source_fingerprint,
  'intent', upper(r.transaction_type), 'price', r.monthly_rent, 'price_unit', 'abs',
  'price_per_sqft', r.rent_per_sqft, 'area_sqft', r.carpet_area_sqft,
  'furnishing', r.fitout_status, 'location_label', coalesce(r.micro_market, r.locality_resolved, r.locality_raw),
  'building_name', r.building_name, 'landmark_name', r.landmark_name, 'micro_market', r.micro_market, 'street_name', r.street_name,
  'developer', null, 'broker_name', r.broker_name, 'broker_phone', r.broker_phone, 'first_seen', r.created_at, 'last_seen', r.updated_at,
  'observation_count', 1, 'group_count', 1, 'latest_raw_message_id', r.raw_message_id, 'representative_raw_message_id', r.raw_message_id,
  'created_at', r.created_at, 'updated_at', r.updated_at, 'tenant_id', r.tenant_id, 'asset_type', r.asset_type,
  'property_type', r.commercial_use_type, 'transaction_type', r.transaction_type, 'commercial_use_type', r.commercial_use_type,
  'fitout_status', r.fitout_status, 'occupancy_type', null, 'deal_tags', r.deal_tags, 'additional_charges', r.additional_charges,
  'carpet_area_sqft', r.carpet_area_sqft, 'built_up_area_sqft', r.built_up_area_sqft, 'car_parking_count', r.car_parking_count,
  'parking_type', r.parking_type, 'deposit_amount', r.deposit_amount, 'possession_date', null, 'possession_status', null,
  'oc_status', r.oc_status, 'ceiling_height', r.ceiling_height, 'price_basis', r.price_basis, 'brokerage_type', r.brokerage_type,
  'lease_term_type', r.lease_term_type, 'amenities', r.building_amenities, 'validation_flags', r.validation_flags,
  'needs_review', r.needs_review, 'representative_listing_index', r.listing_index
))).* from public.commercial_rent_listings r;

create or replace view public.typed_market_requirements
with (security_invoker = true)
as
select (jsonb_populate_record(null::public.market_requirements_legacy, jsonb_build_object(
  'id', coalesce(r.legacy_source_id, r.id), 'fingerprint', r.source_fingerprint, 'intent', 'BUY',
  'transaction_type', r.transaction_type, 'bhk', case when cardinality(r.bhk_options)>0 then r.bhk_options[1]::text end,
  'price_min', r.budget_min, 'price_max', r.budget_max, 'price_unit', 'INR',
  'area_sqft', coalesce(r.carpet_area_max_sqft, r.area_max_sqft), 'location_label', coalesce(r.locality_raw, r.locality_resolved, r.micro_market),
  'building_name', r.building_name, 'landmark_name', r.landmark_name, 'micro_market', r.micro_market,
  'broker_id', r.broker_id, 'broker_name', r.broker_name, 'broker_phone', r.broker_phone,
  'raw_message_id', r.raw_message_id, 'confidence', case r.extraction_confidence when 'high' then 1 when 'medium' then .7 else .4 end,
  'first_seen', r.created_at, 'last_seen', r.updated_at, 'created_at', r.created_at, 'updated_at', r.updated_at, 'tenant_id', r.tenant_id
))).* from public.residential_sale_requirements r
union all select (jsonb_populate_record(null::public.market_requirements_legacy, jsonb_build_object(
  'id', coalesce(r.legacy_source_id, r.id), 'fingerprint', r.source_fingerprint, 'intent', 'BUY', 'transaction_type', r.transaction_type,
  'bhk', case when cardinality(r.bhk_options)>0 then r.bhk_options[1]::text end, 'price_min', r.budget_min, 'price_max', r.budget_max, 'price_unit', 'INR',
  'area_sqft', coalesce(r.carpet_area_max_sqft, r.area_max_sqft), 'location_label', coalesce(r.locality_raw, r.locality_resolved, r.micro_market),
  'building_name', r.building_name, 'landmark_name', r.landmark_name, 'micro_market', r.micro_market, 'broker_id', r.broker_id,
  'broker_name', r.broker_name, 'broker_phone', r.broker_phone, 'raw_message_id', r.raw_message_id,
  'confidence', case r.extraction_confidence when 'high' then 1 when 'medium' then .7 else .4 end, 'first_seen', r.created_at, 'last_seen', r.updated_at,
  'created_at', r.created_at, 'updated_at', r.updated_at, 'tenant_id', r.tenant_id
))).* from public.residential_rent_requirements r
union all select (jsonb_populate_record(null::public.market_requirements_legacy, jsonb_build_object(
  'id', coalesce(r.legacy_source_id, r.id), 'fingerprint', r.source_fingerprint, 'intent', 'BUY', 'transaction_type', r.transaction_type,
  'price_min', r.budget_min, 'price_max', r.budget_max, 'price_unit', 'INR', 'area_sqft', coalesce(r.carpet_area_max_sqft, r.area_max_sqft),
  'location_label', coalesce(r.locality_raw, r.locality_resolved, r.micro_market), 'building_name', r.building_name, 'micro_market', r.micro_market,
  'broker_id', r.broker_id, 'broker_name', r.broker_name, 'broker_phone', r.broker_phone, 'raw_message_id', r.raw_message_id,
  'confidence', case r.extraction_confidence when 'high' then 1 when 'medium' then .7 else .4 end, 'first_seen', r.created_at, 'last_seen', r.updated_at,
  'created_at', r.created_at, 'updated_at', r.updated_at, 'tenant_id', r.tenant_id
))).* from public.commercial_sale_requirements r
union all select (jsonb_populate_record(null::public.market_requirements_legacy, jsonb_build_object(
  'id', coalesce(r.legacy_source_id, r.id), 'fingerprint', r.source_fingerprint, 'intent', 'BUY', 'transaction_type', r.transaction_type,
  'price_min', r.budget_min, 'price_max', r.budget_max, 'price_unit', 'INR', 'area_sqft', coalesce(r.carpet_area_max_sqft, r.area_max_sqft),
  'location_label', coalesce(r.locality_raw, r.locality_resolved, r.micro_market), 'building_name', r.building_name, 'micro_market', r.micro_market,
  'broker_id', r.broker_id, 'broker_name', r.broker_name, 'broker_phone', r.broker_phone, 'raw_message_id', r.raw_message_id,
  'confidence', case r.extraction_confidence when 'high' then 1 when 'medium' then .7 else .4 end, 'first_seen', r.created_at, 'last_seen', r.updated_at,
  'created_at', r.created_at, 'updated_at', r.updated_at, 'tenant_id', r.tenant_id
))).* from public.commercial_rent_requirements r;

commit;
