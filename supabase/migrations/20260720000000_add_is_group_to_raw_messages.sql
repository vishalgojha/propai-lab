-- Add is_group boolean to raw_messages so group filtering is done at
-- ingestion time (whatsmeow already knows info.IsGroup) instead of
-- reverse-engineering group_name patterns in Python/SQL.

alter table raw_messages
    add column if not exists is_group boolean not null default false;

-- Backfill from existing data
update raw_messages
set is_group = true
where is_group = false
  and (
    group_name like '%@g.us'
    or coalesce(message_uid, '') like '%@g.us'
    or coalesce((raw_payload->'key'->>'remoteJid'), '') like '%@g.us'
  );

create index if not exists idx_raw_messages_is_group
    on raw_messages (is_group) where is_group = true;

-- Update get_market_brokers_feed to use r.is_group instead of market_is_group()
create or replace function public.get_market_brokers_feed(
    p_limit integer default 50,
    p_offset integer default 0,
    p_min_observations integer default 1,
    p_tenant_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
with source_inputs as (
    select
        p.id as parsed_id,
        p.raw_message_id,
        p.message_type,
        p.intent,
        p.building_name,
        p.micro_market,
        p.summary_title,
        r.message,
        r.group_name,
        coalesce(r."timestamp", p.created_at, r.created_at) as seen_at,
        coalesce(
            public.market_normalize_phone(p.broker_phone),
            public.market_normalize_phone(r.sender_phone),
            public.market_normalize_phone(r.sender_jid)
        ) as phone,
        coalesce(
            public.market_clean_person_name(p.broker_name),
            public.market_clean_person_name(p.profile_name),
            public.market_clean_person_name(r.sender)
        ) as display_name
    from public.parsed_output p
    join public.raw_messages r on r.id = p.raw_message_id
    where p.created_at >= now() - interval '30 days'
      and (p_tenant_id is null or p.tenant_id = p_tenant_id)
      and r.is_group = true
), source_rows as (
    select
        source_inputs.*,
        public.market_name_key(display_name) as name_key
    from source_inputs
), identity_links as (
    select
        name_key,
        min(phone) as linked_phone
    from source_rows
    where name_key is not null and phone is not null
    group by name_key
    having count(distinct phone) = 1
), identified as (
    select
        s.*,
        coalesce(s.phone, l.linked_phone) as resolved_phone,
        case
            when coalesce(s.phone, l.linked_phone) is not null
                then coalesce(s.phone, l.linked_phone)
            when s.name_key is not null
                then 'name:' || s.name_key
            else null
        end as identity_key
    from source_rows s
    left join identity_links l on l.name_key = s.name_key
), eligible as (
    select i.*
    from identified i
    where i.identity_key is not null
      and not exists (
          select 1
          from public.brokers hidden
          where hidden.is_hidden = true
            and (p_tenant_id is null or hidden.tenant_id = p_tenant_id)
            and (
                hidden.identity_key = i.identity_key
                or (i.resolved_phone is not null and hidden.primary_phone = i.resolved_phone)
            )
      )
), aggregates as (
    select
        identity_key,
        max(resolved_phone) as primary_phone,
        count(*)::integer as observation_count,
        count(*) filter (
            where upper(coalesce(intent, '')) not in ('BUY', 'BUYER', 'REQUIREMENT', 'RENTAL_SEEKER')
        )::integer as listing_count,
        count(*) filter (
            where upper(coalesce(intent, '')) in ('BUY', 'BUYER', 'REQUIREMENT', 'RENTAL_SEEKER')
        )::integer as requirement_count,
        count(distinct nullif(btrim(building_name), ''))::integer as building_count,
        count(distinct seen_at::date) filter (
            where seen_at >= now() - interval '30 days'
        )::integer as active_days_30,
        min(seen_at) as first_seen,
        max(seen_at) as last_active,
        count(distinct group_name)::integer as group_evidence_count
    from eligible
    group by identity_key
    having count(*) >= greatest(p_min_observations, 1)
), name_counts as (
    select
        identity_key,
        display_name,
        count(*) as sightings,
        max(seen_at) as latest_name_seen,
        row_number() over (
            partition by identity_key
            order by count(*) desc, max(seen_at) desc, display_name asc
        ) as rank
    from eligible
    where display_name is not null
    group by identity_key, display_name
), latest_rows as (
    select
        identity_key,
        summary_title,
        message,
        intent,
        micro_market,
        row_number() over (
            partition by identity_key
            order by seen_at desc, parsed_id desc
        ) as rank
    from eligible
), channel_rows as (
    select
        identity_key,
        jsonb_agg(
            jsonb_build_object('source', group_name, 'type', 'group')
            order by group_name
        ) as channels
    from (
        select distinct identity_key, group_name
        from eligible
        where coalesce(btrim(group_name), '') != ''
    ) distinct_channels
    group by identity_key
), page as (
    select
        a.identity_key as id,
        a.identity_key,
        coalesce(a.primary_phone, a.identity_key) as primary_phone,
        coalesce(n.display_name, a.primary_phone, 'Unknown broker') as canonical_name,
        a.building_count,
        a.active_days_30,
        a.observation_count,
        a.listing_count,
        a.requirement_count,
        a.observation_count as obs_count,
        a.last_active,
        a.first_seen,
        a.group_evidence_count,
        0::integer as dm_evidence_count,
        a.group_evidence_count as unique_channel_count,
        coalesce(l.summary_title, l.message, '') as latest_title,
        l.intent as latest_intent,
        l.micro_market as latest_micro_market,
        coalesce(c.channels, '[]'::jsonb) as channels
    from aggregates a
    left join name_counts n on n.identity_key = a.identity_key and n.rank = 1
    left join latest_rows l on l.identity_key = a.identity_key and l.rank = 1
    left join channel_rows c on c.identity_key = a.identity_key
    order by a.last_active desc, a.identity_key asc
    limit greatest(least(p_limit, 500), 1)
    offset greatest(p_offset, 0)
)
select coalesce(jsonb_agg(to_jsonb(page) order by last_active desc, identity_key asc), '[]'::jsonb)
from page;
$$;

-- Update get_market_observations_feed similarly
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
with requested_input as (
    select
        public.market_normalize_phone(p_broker_key) as requested_phone,
        case
            when public.market_normalize_phone(p_broker_key) is null
                then public.market_name_key(regexp_replace(p_broker_key, '^name:', '', 'i'))
            else null
        end as requested_name_key
), source_inputs as (
    select
        p.*,
        r.message as raw_message,
        r.sender as raw_sender,
        r.group_name,
        coalesce(r."timestamp", p.created_at, r.created_at) as seen_at,
        coalesce(
            public.market_normalize_phone(p.broker_phone),
            public.market_normalize_phone(r.sender_phone),
            public.market_normalize_phone(r.sender_jid)
        ) as effective_phone,
        coalesce(
            public.market_clean_person_name(p.broker_name),
            public.market_clean_person_name(p.profile_name),
            public.market_clean_person_name(r.sender)
        ) as effective_name
    from public.parsed_output p
    join public.raw_messages r on r.id = p.raw_message_id
    where p.created_at >= now() - interval '30 days'
      and (p_tenant_id is null or p.tenant_id = p_tenant_id)
      and (coalesce(p_intent, '') = '' or upper(p.intent) = upper(p_intent))
      and r.is_group = true
), source_rows as (
    select
        source_inputs.*,
        public.market_name_key(effective_name) as name_key
    from source_inputs
), identity_links as (
    select
        name_key,
        min(effective_phone) as linked_phone
    from source_rows
    where name_key is not null and effective_phone is not null
    group by name_key
    having count(distinct effective_phone) = 1
), requested as (
    select case
        when requested_input.requested_phone is not null
            then requested_input.requested_phone
        when requested_input.requested_name_key is not null
            then coalesce(
                identity_links.linked_phone,
                'name:' || requested_input.requested_name_key
            )
        else null
    end as identity_key
    from requested_input
    left join identity_links
        on identity_links.name_key = requested_input.requested_name_key
), identified as (
    select
        s.*,
        coalesce(s.effective_phone, l.linked_phone) as resolved_phone,
        case
            when coalesce(s.effective_phone, l.linked_phone) is not null
                then coalesce(s.effective_phone, l.linked_phone)
            when s.name_key is not null
                then 'name:' || s.name_key
            else null
        end as effective_identity_key
    from source_rows s
    left join identity_links l on l.name_key = s.name_key
), page as (
    select i.*
    from identified i
    cross join requested r
    where r.identity_key is not null
      and i.effective_identity_key = r.identity_key
    order by i.seen_at desc, i.id desc
    limit greatest(least(p_limit, 500), 1)
    offset greatest(p_offset, 0)
)
select coalesce(
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
            'observation_type', case
                when upper(coalesce(page.intent, '')) in ('BUY', 'BUYER', 'REQUIREMENT', 'RENTAL_SEEKER')
                    then 'REQUIREMENT'
                else 'LISTING'
            end,
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
            'broker_phone', page.resolved_phone
        )
        order by page.seen_at desc, page.id desc
    ),
    '[]'::jsonb
)
from page;
$$;
