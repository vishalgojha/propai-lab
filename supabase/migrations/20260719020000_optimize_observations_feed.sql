-- Optimize get_market_observations_feed: push broker filter early
-- instead of scanning all 30 days of parsed_output first.

-- 1. Covering index for broker+time filter (avoids heap lookups)
CREATE INDEX IF NOT EXISTS idx_parsed_output_broker_created
  ON public.parsed_output (broker_phone, created_at DESC)
  INCLUDE (raw_message_id, intent, message_type, bhk, price, area_sqft,
           furnishing, building_name, micro_market, summary_title,
           normalized_message, asset_type, property_type, transaction_type,
           furnishing_canonical, tenant_id, broker_name, profile_name,
           configuration, price_unit, price_model, price_per_sqft,
           monthly_rent, total_asking_price, listing_index, confidence,
           availability_status, possession_status, possession_date,
           available_from, ready_by, construction_stage, launch_timeline,
           expected_possession);

-- 2. Index for the group_name filter
CREATE INDEX IF NOT EXISTS idx_raw_messages_group_name
  ON public.raw_messages (group_name)
  WHERE group_name IS NOT NULL;

-- 3. Optimized function: single-pass with early broker filter
CREATE OR REPLACE FUNCTION public.get_market_observations_feed(
    p_limit integer DEFAULT 50,
    p_offset integer DEFAULT 0,
    p_broker_key text DEFAULT '',
    p_intent text DEFAULT '',
    p_tenant_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
WITH requested_input AS (
    SELECT
        public.market_normalize_phone(p_broker_key) AS requested_phone,
        CASE
            WHEN public.market_normalize_phone(p_broker_key) IS NULL
                THEN public.market_name_key(regexp_replace(p_broker_key, '^name:', '', 'i'))
            ELSE NULL
        END AS requested_name_key
),
source_rows AS (
    SELECT
        p.*,
        r.message AS raw_message,
        r.sender AS raw_sender,
        r.group_name,
        coalesce(r."timestamp", p.created_at, r.created_at) AS seen_at,
        coalesce(
            public.market_normalize_phone(p.broker_phone),
            public.market_normalize_phone(r.sender_phone),
            public.market_normalize_phone(r.sender_jid)
        ) AS effective_phone,
        coalesce(
            public.market_clean_person_name(p.broker_name),
            public.market_clean_person_name(p.profile_name),
            public.market_clean_person_name(r.sender)
        ) AS effective_name
    FROM public.parsed_output p
    JOIN public.raw_messages r ON r.id = p.raw_message_id
    CROSS JOIN requested_input ri
    WHERE p.created_at >= now() - interval '30 days'
      AND (p_tenant_id IS NULL OR p.tenant_id = p_tenant_id)
      AND (coalesce(p_intent, '') = '' OR upper(p.intent) = upper(p_intent))
      AND public.market_is_group(r.group_name)
      AND (
          -- Phone-based: filter directly by normalized broker phone
          (ri.requested_phone IS NOT NULL
           AND public.market_normalize_phone(p.broker_phone) = ri.requested_phone)
          OR
          -- Name-based: match by name key across broker_name / profile_name / sender
          (ri.requested_name_key IS NOT NULL
           AND public.market_name_key(
               coalesce(
                   public.market_clean_person_name(p.broker_name),
                   public.market_clean_person_name(p.profile_name),
                   public.market_clean_person_name(r.sender)
               )
           ) = ri.requested_name_key)
      )
),
identified AS (
    SELECT
        s.*,
        CASE
            WHEN s.effective_phone IS NOT NULL THEN s.effective_phone
            WHEN s.effective_name IS NOT NULL THEN 'name:' || public.market_name_key(s.effective_name)
            ELSE NULL
        END AS effective_identity_key
    FROM source_rows s
),
page AS (
    SELECT i.*
    FROM identified i
    WHERE i.effective_identity_key IS NOT NULL
    ORDER BY i.seen_at DESC, i.id DESC
    LIMIT greatest(least(p_limit, 500), 1)
    OFFSET greatest(p_offset, 0)
)
SELECT coalesce(
    jsonb_agg(
        jsonb_build_object(
            'id', page.id,
            'fingerprint', 'parsed:' || page.id::text,
            'broker_key', page.effective_identity_key,
            'summary_title', coalesce(
                page.summary_title,
                to_jsonb(page)->>'normalized_message',
                page.raw_message,
                ''
            ),
            'observation_type', CASE
                WHEN upper(coalesce(page.intent, '')) IN ('BUY', 'BUYER', 'REQUIREMENT', 'RENTAL_SEEKER')
                    THEN 'REQUIREMENT'
                ELSE 'LISTING'
            END,
            'intent', page.intent,
            'asset_type', page.asset_type,
            'property_type', coalesce(page.property_type, page.message_type),
            'transaction_type', page.transaction_type,
            'bhk', page.bhk,
            'configuration', page.configuration,
            'price', page.price,
            'price_unit', page.price_unit,
            'price_model', page.price_model,
            'price_per_sqft', page.price_per_sqft,
            'monthly_rent', page.monthly_rent,
            'total_asking_price', page.total_asking_price,
            'area_sqft', page.area_sqft,
            'furnishing', page.furnishing,
            'furnishing_canonical', page.furnishing_canonical,
            'building_name', page.building_name,
            'micro_market', page.micro_market,
            'location_raw', page.location_raw,
            'commercial_use_type', to_jsonb(page)->>'commercial_use_type',
            'fitout_status', to_jsonb(page)->>'fitout_status',
            'occupancy_type', to_jsonb(page)->>'occupancy_type',
            'floor_range', to_jsonb(page)->>'floor_range',
            'availability_status', page.availability_status,
            'possession_status', page.possession_status,
            'possession_date', page.possession_date,
            'available_from', page.available_from,
            'ready_by', page.ready_by,
            'construction_stage', page.construction_stage,
            'launch_timeline', page.launch_timeline,
            'expected_possession', page.expected_possession,
            'listing_index', page.listing_index,
            'first_seen', page.seen_at,
            'last_seen', page.seen_at,
            'times_seen', 1,
            'evidence_list', jsonb_build_array(jsonb_build_object(
                'type', 'group',
                'source', page.group_name,
                'seen_at', page.seen_at
            )),
            'latest_raw_message_id', page.raw_message_id,
            'latest_parsed_id', page.id,
            'raw_message', coalesce(page.raw_message, ''),
            'raw_sender', coalesce(page.raw_sender, page.effective_name, ''),
            'broker_name', page.effective_name,
            'broker_phone', page.effective_phone
        )
        ORDER BY page.seen_at DESC, page.id DESC
    ),
    '[]'::jsonb
)
FROM page;
$$;
