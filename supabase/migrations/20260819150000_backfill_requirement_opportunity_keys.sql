-- Backfill the deterministic opportunity identity for historical requirement
-- rows that predate the canonical opportunity_key column.  This is identity
-- enrichment only: it never merges, deletes, or changes duplicate status.
--
-- Keep the field set aligned with storage.supabase._observation_fingerprint:
-- transaction/asset, requirement configuration, location, budget/area where
-- available, and broker identity.  Missing fields remain empty so unrelated
-- requirements are not collapsed by this migration.
do $$
declare
    table_name text;
begin
    foreach table_name in array array[
        'residential_sale_requirements',
        'residential_rent_requirements',
        'commercial_sale_requirements',
        'commercial_rent_requirements'
    ] loop
        execute format($sql$
            update public.%I
            set opportunity_key = md5(
                jsonb_build_object(
                    'observation_type', '',
                    'transaction_type', coalesce(transaction_type, ''),
                    'asset_type', coalesce(asset_type, ''),
                    'bhk', coalesce(configuration_type, '') || ':' || coalesce(bhk_options::text, ''),
                    'price', '',
                    'area_sqft', coalesce(area_min_sqft::text, '') || ':' || coalesce(area_max_sqft::text, ''),
                    'furnishing', coalesce(furnishing_preference, ''),
                    'building_name', coalesce(building_name, ''),
                    'landmark_name', coalesce(landmark_name, ''),
                    'micro_market', coalesce(micro_market, '') || ':' || coalesce(micro_market_options::text, ''),
                    'location_raw', coalesce(locality_options::text, ''),
                    'floor_range', coalesce(floor_preference, ''),
                    'wing', '',
                    'flat_number', '',
                    'broker_identity', coalesce(broker_id::text, broker_phone, broker_name, '')
                )::text
            )
            where opportunity_key is null
        $sql$, table_name);
    end loop;
end $$;

create index if not exists residential_sale_requirements_opportunity_key_idx
    on public.residential_sale_requirements (opportunity_key, last_seen_at desc);
create index if not exists residential_rent_requirements_opportunity_key_idx
    on public.residential_rent_requirements (opportunity_key, last_seen_at desc);
create index if not exists commercial_sale_requirements_opportunity_key_idx
    on public.commercial_sale_requirements (opportunity_key, last_seen_at desc);
create index if not exists commercial_rent_requirements_opportunity_key_idx
    on public.commercial_rent_requirements (opportunity_key, last_seen_at desc);
