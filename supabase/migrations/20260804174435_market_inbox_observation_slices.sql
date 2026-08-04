-- Make Market Inbox observations item-aware.
--
-- The previous feed projected a synthetic typed:<id> fingerprint and only
-- returned the complete raw WhatsApp message. That made repost deduplication
-- impossible and made several listings from one bulk post render as one post.
-- Read directly from the typed source tables and expose the stable provenance
-- plus the per-item source slice retained by extraction.

create or replace function public.get_market_observations_feed(
    p_limit integer default 50,
    p_offset integer default 0,
    p_broker_key text default '',
    p_intent text default '',
    p_tenant_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
with typed_rows as (
    select id, raw_message_id, tenant_id, listing_index, source_fingerprint,
           building_name, micro_market, broker_name, broker_phone,
           asset_type, locality_raw, group_name,
           bhk::text as bhk, carpet_area_sqft as area_sqft,
           total_asking_price as price, 'sale'::text as transaction_type,
           needs_review, created_at, normalized_message, raw_payload,
           summary_title, floor_range, null::text as flat_number,
           null::text as wing, car_parking_count
      from public.residential_sale_listings
    union all
    select id, raw_message_id, tenant_id, listing_index, source_fingerprint,
           building_name, micro_market, broker_name, broker_phone,
           asset_type, locality_raw, group_name,
           bhk::text, carpet_area_sqft, monthly_rent, 'rent'::text,
           needs_review, created_at, normalized_message, raw_payload,
           summary_title, floor_range, null::text, null::text,
           car_parking_count
      from public.residential_rent_listings
    union all
    select id, raw_message_id, tenant_id, listing_index, source_fingerprint,
           building_name, micro_market, broker_name, broker_phone,
           asset_type, locality_raw, group_name,
           null::text, carpet_area_sqft, total_asking_price, 'sale'::text,
           needs_review, created_at, normalized_message, raw_payload,
           summary_title, floor_range, null::text, null::text,
           car_parking_count
      from public.commercial_sale_listings
    union all
    select id, raw_message_id, tenant_id, listing_index, source_fingerprint,
           building_name, micro_market, broker_name, broker_phone,
           asset_type, locality_raw, group_name,
           null::text, carpet_area_sqft, monthly_rent, 'rent'::text,
           needs_review, created_at, normalized_message, raw_payload,
           summary_title, floor_range, null::text, null::text,
           car_parking_count
      from public.commercial_rent_listings
    union all
    select id, raw_message_id, tenant_id, listing_index, source_fingerprint,
           building_name, micro_market, broker_name, broker_phone,
           asset_type, locality_raw, group_name,
           coalesce(bhk_options[1]::text, ''), coalesce(carpet_area_max_sqft, area_max_sqft),
           budget_max, coalesce(nullif(transaction_type, ''), 'sale')::text,
           needs_review, created_at, normalized_message, raw_payload,
           summary_title, floor_range, null::text, null::text,
           null::integer
      from public.residential_sale_requirements
    union all
    select id, raw_message_id, tenant_id, listing_index, source_fingerprint,
           building_name, micro_market, broker_name, broker_phone,
           asset_type, locality_raw, group_name,
           coalesce(bhk_options[1]::text, ''), coalesce(carpet_area_max_sqft, area_max_sqft),
           budget_max, coalesce(nullif(transaction_type, ''), 'rent')::text,
           needs_review, created_at, normalized_message, raw_payload,
           summary_title, floor_range, null::text, null::text,
           null::integer
      from public.residential_rent_requirements
    union all
    select id, raw_message_id, tenant_id, listing_index, source_fingerprint,
           building_name, micro_market, broker_name, broker_phone,
           asset_type, locality_raw, group_name,
           null::text, coalesce(carpet_area_max_sqft, area_max_sqft), budget_max,
           coalesce(nullif(transaction_type, ''), 'sale')::text,
           needs_review, created_at, normalized_message, raw_payload,
           summary_title, floor_range, null::text, null::text,
           null::integer
      from public.commercial_sale_requirements
    union all
    select id, raw_message_id, tenant_id, listing_index, source_fingerprint,
           building_name, micro_market, broker_name, broker_phone,
           asset_type, locality_raw, group_name,
           null::text, coalesce(carpet_area_max_sqft, area_max_sqft), budget_max,
           coalesce(nullif(transaction_type, ''), 'rent')::text,
           needs_review, created_at, normalized_message, raw_payload,
           summary_title, floor_range, null::text, null::text,
           null::integer
      from public.commercial_rent_requirements
), source_rows as (
    select t.*, r.message as raw_message, r.sender as raw_sender,
           coalesce(nullif(r.group_name, ''), t.group_name) as source_group_name,
           coalesce(r."timestamp", t.created_at, r.created_at) as seen_at
      from typed_rows t
      join public.raw_messages r on r.id = t.raw_message_id
     where (p_tenant_id is null or t.tenant_id = p_tenant_id)
       and (coalesce(p_intent, '') = '' or upper(t.transaction_type) = upper(p_intent))
       and t.created_at >= now() - interval '30 days'
       and (
         nullif(trim(p_broker_key), '') is null
         or (
           public.market_normalize_phone(p_broker_key) is not null
           and right(regexp_replace(coalesce(t.broker_phone, ''), '\\D', '', 'g'), 10) = public.market_normalize_phone(p_broker_key)
         )
         or (lower(p_broker_key) like 'name:%' and lower(coalesce(t.broker_name, '')) like '%' || lower(regexp_replace(p_broker_key, '^name:', '', 'i')) || '%')
       )
), page as (
    select * from source_rows
    order by seen_at desc nulls last, id desc
    limit greatest(least(coalesce(p_limit, 50), 500), 1)
    offset greatest(coalesce(p_offset, 0), 0)
)
select coalesce(jsonb_agg(jsonb_build_object(
    'id', page.id,
    'fingerprint', page.source_fingerprint,
    'listing_index', page.listing_index,
    'broker_key', 'phone:' || right(regexp_replace(coalesce(page.broker_phone, ''), '\\D', '', 'g'), 10),
    'summary_title', coalesce(page.summary_title, page.building_name, ''),
    'observation_type', case when lower(page.transaction_type) in ('buy','requirement','wanted') then 'REQUIREMENT' else 'LISTING' end,
    'property_type', page.asset_type,
    'intent', page.transaction_type,
    'transaction_type', page.transaction_type,
    'bhk', page.bhk,
    'price', page.price,
    'area_sqft', page.area_sqft,
    'building_name', page.building_name,
    'location_raw', page.locality_raw,
    'micro_market', page.micro_market,
    'floor_range', page.floor_range,
    'flat_number', page.flat_number,
    'wing', page.wing,
    'car_parking_count', page.car_parking_count,
    'first_seen', page.seen_at,
    'last_seen', page.seen_at,
    'times_seen', 1,
    'evidence_list', case when coalesce(page.source_group_name, '') <> '' then jsonb_build_array(jsonb_build_object('type', 'group', 'source', page.source_group_name, 'seen_at', page.seen_at)) else '[]'::jsonb end,
    'latest_raw_message_id', page.raw_message_id,
    'latest_parsed_id', page.id,
    'raw_message', coalesce(page.raw_message, ''),
    'source_message', coalesce(nullif(page.raw_payload->>'slice_text', ''), nullif(page.normalized_message, ''), page.raw_message, ''),
    'normalized_message', coalesce(page.normalized_message, ''),
    'raw_sender', coalesce(page.raw_sender, page.broker_name, ''),
    'broker_name', page.broker_name,
    'broker_phone', page.broker_phone,
    'source_scope', 'connected_group',
    'market_scope', 'workspace'
) order by page.seen_at desc nulls last, page.id desc), '[]'::jsonb)
from page;
$$;

revoke all on function public.get_market_observations_feed(integer, integer, text, text, uuid) from public, anon, authenticated;
grant execute on function public.get_market_observations_feed(integer, integer, text, text, uuid) to service_role;

notify pgrst, 'reload schema';
