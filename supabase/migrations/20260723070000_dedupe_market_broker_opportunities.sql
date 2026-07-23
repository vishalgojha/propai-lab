-- Market Inbox represents unique broker opportunities, not WhatsApp reposts.
-- A broker posting the same listing/requirement repeatedly must increase
-- recency/evidence, but not the inventory count shown in the broker list.

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
        p.asset_type,
        p.property_type,
        p.transaction_type,
        p.bhk,
        p.configuration,
        p.price,
        p.monthly_rent,
        p.total_asking_price,
        p.area_sqft,
        p.furnishing,
        p.building_name,
        p.landmark_name,
        p.micro_market,
        p.location_raw,
        p.floor_range,
        p.commercial_use_type,
        p.occupancy_type,
        p.normalized_message,
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
    select source_inputs.*, public.market_name_key(display_name) as name_key
    from source_inputs
), identity_links as (
    select name_key, min(phone) as linked_phone
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
            when s.name_key is not null then 'name:' || s.name_key
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
), opportunities as (
    select
        e.*,
        md5(concat_ws('|',
            case
                when upper(coalesce(e.message_type, '')) = 'REQUIREMENT'
                  or upper(coalesce(e.intent, '')) in ('BUY', 'BUYER', 'REQUIREMENT', 'RENTAL_SEEKER', 'WANTED')
                    then 'requirement'
                else 'listing'
            end,
            regexp_replace(lower(coalesce(e.intent, '')), '[^a-z0-9]+', ' ', 'g'),
            regexp_replace(lower(coalesce(e.transaction_type, '')), '[^a-z0-9]+', ' ', 'g'),
            regexp_replace(lower(coalesce(e.asset_type, '')), '[^a-z0-9]+', ' ', 'g'),
            regexp_replace(lower(coalesce(e.property_type, '')), '[^a-z0-9]+', ' ', 'g'),
            regexp_replace(lower(coalesce(e.bhk, e.configuration, '')), '[^a-z0-9]+', ' ', 'g'),
            coalesce(e.price, e.monthly_rent, e.total_asking_price)::text,
            coalesce(e.area_sqft::text, ''),
            regexp_replace(lower(coalesce(e.furnishing, '')), '[^a-z0-9]+', ' ', 'g'),
            regexp_replace(lower(coalesce(e.building_name, '')), '[^a-z0-9]+', ' ', 'g'),
            regexp_replace(lower(coalesce(e.landmark_name, '')), '[^a-z0-9]+', ' ', 'g'),
            regexp_replace(lower(coalesce(e.micro_market, '')), '[^a-z0-9]+', ' ', 'g'),
            regexp_replace(lower(coalesce(e.location_raw, '')), '[^a-z0-9]+', ' ', 'g'),
            regexp_replace(lower(coalesce(e.floor_range, '')), '[^a-z0-9]+', ' ', 'g'),
            regexp_replace(lower(coalesce(e.commercial_use_type, '')), '[^a-z0-9]+', ' ', 'g'),
            regexp_replace(lower(coalesce(e.occupancy_type, '')), '[^a-z0-9]+', ' ', 'g'),
            case
                when coalesce(
                    nullif(btrim(e.bhk), ''), nullif(btrim(e.configuration), ''),
                    e.price::text, e.monthly_rent::text, e.total_asking_price::text,
                    e.area_sqft::text, nullif(btrim(e.building_name), ''),
                    nullif(btrim(e.landmark_name), ''), nullif(btrim(e.micro_market), ''),
                    nullif(btrim(e.location_raw), '')
                ) is null
                then regexp_replace(
                    lower(coalesce(e.normalized_message, e.summary_title, e.message, '')),
                    '[^a-z0-9]+', ' ', 'g'
                )
                else ''
            end
        )) as opportunity_key
    from eligible e
), ranked_opportunities as (
    select
        o.*,
        row_number() over (
            partition by o.identity_key, o.opportunity_key
            order by o.seen_at desc, o.parsed_id desc
        ) as opportunity_rank
    from opportunities o
), unique_opportunities as (
    select *
    from ranked_opportunities
    where opportunity_rank = 1
), aggregates as (
    select
        identity_key,
        max(resolved_phone) as primary_phone,
        count(distinct opportunity_key)::integer as observation_count,
        count(distinct opportunity_key) filter (
            where not (
                upper(coalesce(message_type, '')) = 'REQUIREMENT'
                or upper(coalesce(intent, '')) in ('BUY', 'BUYER', 'REQUIREMENT', 'RENTAL_SEEKER', 'WANTED')
            )
        )::integer as listing_count,
        count(distinct opportunity_key) filter (
            where upper(coalesce(message_type, '')) = 'REQUIREMENT'
               or upper(coalesce(intent, '')) in ('BUY', 'BUYER', 'REQUIREMENT', 'RENTAL_SEEKER', 'WANTED')
        )::integer as requirement_count,
        count(distinct nullif(btrim(building_name), ''))::integer as building_count,
        count(distinct seen_at::date) filter (where seen_at >= now() - interval '30 days')::integer as active_days_30,
        min(seen_at) as first_seen,
        max(seen_at) as last_active,
        count(distinct group_name)::integer as group_evidence_count
    from unique_opportunities
    group by identity_key
    having count(distinct opportunity_key) >= greatest(p_min_observations, 1)
), locality_counts as (
    select
        identity_key,
        coalesce(nullif(btrim(micro_market), ''), nullif(btrim(location_raw), '')) as locality,
        count(*) as opportunity_count,
        max(seen_at) as latest_seen
    from unique_opportunities
    where coalesce(nullif(btrim(micro_market), ''), nullif(btrim(location_raw), '')) is not null
    group by identity_key, coalesce(nullif(btrim(micro_market), ''), nullif(btrim(location_raw), ''))
), ranked_localities as (
    select
        locality_counts.*,
        row_number() over (
            partition by identity_key
            order by opportunity_count desc, latest_seen desc, locality asc
        ) as rank
    from locality_counts
), specialty_localities as (
    select
        identity_key,
        jsonb_agg(locality order by rank) filter (where rank <= 3) as localities
    from ranked_localities
    group by identity_key
), property_type_counts as (
    select
        identity_key,
        coalesce(nullif(btrim(asset_type), ''), nullif(btrim(property_type), '')) as property_type,
        count(*) as opportunity_count,
        max(seen_at) as latest_seen
    from unique_opportunities
    where coalesce(nullif(btrim(asset_type), ''), nullif(btrim(property_type), '')) is not null
    group by identity_key, coalesce(nullif(btrim(asset_type), ''), nullif(btrim(property_type), ''))
), ranked_property_types as (
    select
        property_type_counts.*,
        row_number() over (
            partition by identity_key
            order by opportunity_count desc, latest_seen desc, property_type asc
        ) as rank
    from property_type_counts
), specialty_property_types as (
    select
        identity_key,
        jsonb_agg(property_type order by rank) filter (where rank <= 2) as property_types
    from ranked_property_types
    group by identity_key
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
    from opportunities
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
    from opportunities
), channel_rows as (
    select
        identity_key,
        jsonb_agg(jsonb_build_object('source', group_name, 'type', 'group') order by group_name) as channels
    from (
        select distinct identity_key, group_name
        from opportunities
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
        coalesce(sl.localities, '[]'::jsonb) as specialty_localities,
        coalesce(sp.property_types, '[]'::jsonb) as specialty_property_types,
        coalesce(c.channels, '[]'::jsonb) as channels
    from aggregates a
    left join name_counts n on n.identity_key = a.identity_key and n.rank = 1
    left join latest_rows l on l.identity_key = a.identity_key and l.rank = 1
    left join channel_rows c on c.identity_key = a.identity_key
    left join specialty_localities sl on sl.identity_key = a.identity_key
    left join specialty_property_types sp on sp.identity_key = a.identity_key
    order by a.last_active desc, a.identity_key asc
    limit greatest(least(p_limit, 500), 1)
    offset greatest(p_offset, 0)
)
select coalesce(jsonb_agg(to_jsonb(page) order by last_active desc, identity_key asc), '[]'::jsonb)
from page;
$$;

revoke all on function public.get_market_brokers_feed(integer, integer, integer, uuid) from public;
grant execute on function public.get_market_brokers_feed(integer, integer, integer, uuid) to service_role;

-- Deduplicate the selected broker's timeline before LIMIT/OFFSET.  Doing this
-- after pagination lets reposts consume page slots and allows the same
-- opportunity to reappear on later pages.
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
    select source_inputs.*, public.market_name_key(effective_name) as name_key
    from source_inputs
), identity_links as (
    select name_key, min(effective_phone) as linked_phone
    from source_rows
    where name_key is not null and effective_phone is not null
    group by name_key
    having count(distinct effective_phone) = 1
), requested as (
    select case
        when requested_input.requested_phone is not null
            then requested_input.requested_phone
        when requested_input.requested_name_key is not null
            then coalesce(identity_links.linked_phone, 'name:' || requested_input.requested_name_key)
        else null
    end as identity_key
    from requested_input
    left join identity_links on identity_links.name_key = requested_input.requested_name_key
), identified as (
    select
        s.*,
        coalesce(s.effective_phone, l.linked_phone) as resolved_phone,
        case
            when coalesce(s.effective_phone, l.linked_phone) is not null
                then coalesce(s.effective_phone, l.linked_phone)
            when s.name_key is not null then 'name:' || s.name_key
            else null
        end as effective_identity_key
    from source_rows s
    left join identity_links l on l.name_key = s.name_key
), eligible as (
    select i.*
    from identified i
    cross join requested r
    where r.identity_key is not null
      and i.effective_identity_key = r.identity_key
), opportunities as (
    select
        e.*,
        case
            when upper(coalesce(e.message_type, '')) = 'REQUIREMENT'
              or upper(coalesce(e.intent, '')) in ('BUY', 'BUYER', 'REQUIREMENT', 'RENTAL_SEEKER', 'WANTED')
                then 'REQUIREMENT'
            else 'LISTING'
        end as opportunity_type,
        md5(concat_ws('|',
            case
                when upper(coalesce(e.message_type, '')) = 'REQUIREMENT'
                  or upper(coalesce(e.intent, '')) in ('BUY', 'BUYER', 'REQUIREMENT', 'RENTAL_SEEKER', 'WANTED')
                    then 'requirement'
                else 'listing'
            end,
            regexp_replace(lower(coalesce(e.intent, '')), '[^a-z0-9]+', ' ', 'g'),
            regexp_replace(lower(coalesce(e.transaction_type, '')), '[^a-z0-9]+', ' ', 'g'),
            regexp_replace(lower(coalesce(e.asset_type, '')), '[^a-z0-9]+', ' ', 'g'),
            regexp_replace(lower(coalesce(e.property_type, '')), '[^a-z0-9]+', ' ', 'g'),
            regexp_replace(lower(coalesce(e.bhk, e.configuration, '')), '[^a-z0-9]+', ' ', 'g'),
            coalesce(e.price, e.monthly_rent, e.total_asking_price)::text,
            coalesce(e.area_sqft::text, ''),
            regexp_replace(lower(coalesce(e.furnishing, '')), '[^a-z0-9]+', ' ', 'g'),
            regexp_replace(lower(coalesce(e.building_name, '')), '[^a-z0-9]+', ' ', 'g'),
            regexp_replace(lower(coalesce(e.landmark_name, '')), '[^a-z0-9]+', ' ', 'g'),
            regexp_replace(lower(coalesce(e.micro_market, '')), '[^a-z0-9]+', ' ', 'g'),
            regexp_replace(lower(coalesce(e.location_raw, '')), '[^a-z0-9]+', ' ', 'g'),
            regexp_replace(lower(coalesce(e.floor_range, '')), '[^a-z0-9]+', ' ', 'g'),
            regexp_replace(lower(coalesce(e.commercial_use_type, '')), '[^a-z0-9]+', ' ', 'g'),
            regexp_replace(lower(coalesce(e.occupancy_type, '')), '[^a-z0-9]+', ' ', 'g'),
            case
                when coalesce(
                    nullif(btrim(e.bhk), ''), nullif(btrim(e.configuration), ''),
                    e.price::text, e.monthly_rent::text, e.total_asking_price::text,
                    e.area_sqft::text, nullif(btrim(e.building_name), ''),
                    nullif(btrim(e.landmark_name), ''), nullif(btrim(e.micro_market), ''),
                    nullif(btrim(e.location_raw), '')
                ) is null
                then regexp_replace(
                    lower(coalesce(e.normalized_message, e.summary_title, e.raw_message, '')),
                    '[^a-z0-9]+', ' ', 'g'
                )
                else ''
            end
        )) as opportunity_key
    from eligible e
), ranked as (
    select
        o.*,
        row_number() over (
            partition by o.opportunity_key
            order by o.seen_at desc, o.id desc
        ) as latest_rank,
        count(*) over (partition by o.opportunity_key) as times_seen,
        min(o.seen_at) over (partition by o.opportunity_key) as first_seen,
        max(o.seen_at) over (partition by o.opportunity_key) as last_seen
    from opportunities o
), evidence_sources as (
    select opportunity_key, group_name, max(seen_at) as seen_at
    from opportunities
    where coalesce(btrim(group_name), '') != ''
    group by opportunity_key, group_name
), evidence as (
    select
        opportunity_key,
        jsonb_agg(
            jsonb_build_object('type', 'group', 'source', group_name, 'seen_at', seen_at)
            order by seen_at desc, group_name asc
        ) as evidence_list
    from evidence_sources
    group by opportunity_key
), page as (
    select r.*, coalesce(e.evidence_list, '[]'::jsonb) as evidence_list
    from ranked r
    left join evidence e on e.opportunity_key = r.opportunity_key
    where r.latest_rank = 1
    order by r.last_seen desc, r.id desc
    limit greatest(least(p_limit, 500), 1)
    offset greatest(p_offset, 0)
)
select coalesce(
    jsonb_agg(
        jsonb_build_object(
            'id', page.id,
            'fingerprint', page.opportunity_key,
            'broker_key', page.effective_identity_key,
            'summary_title', coalesce(
                page.summary_title,
                to_jsonb(page)->>'normalized_message',
                page.raw_message,
                ''
            ),
            'observation_type', page.opportunity_type,
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
            'first_seen', page.first_seen,
            'last_seen', page.last_seen,
            'times_seen', page.times_seen,
            'evidence_list', page.evidence_list,
            'latest_raw_message_id', page.raw_message_id,
            'latest_parsed_id', page.id,
            'raw_message', coalesce(page.raw_message, ''),
            'raw_sender', coalesce(page.raw_sender, page.effective_name, ''),
            'broker_name', page.effective_name,
            'broker_phone', page.resolved_phone
        )
        order by page.last_seen desc, page.id desc
    ),
    '[]'::jsonb
)
from page;
$$;

revoke all on function public.get_market_observations_feed(integer, integer, text, text, uuid) from public;
grant execute on function public.get_market_observations_feed(integer, integer, text, text, uuid) to service_role;
