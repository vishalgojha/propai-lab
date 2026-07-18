-- Stable, database-side Market Inbox broker aggregation.
--
-- The application previously downloaded a moving window of 5,000 parsed rows,
-- grouped them in Python, and then paginated the grouped result.  Under active
-- WhatsApp ingestion that made the broker list churn between refreshes and made
-- name-only observation lookups perform several large network scans.

create or replace function public.market_normalize_phone(p_value text)
returns text
language plpgsql
immutable
security invoker
set search_path = public
as $$
declare
    local_part text;
    digits text;
begin
    if p_value is null or p_value ~ '[xX*\u2022]' then
        return null;
    end if;

    -- WhatsApp IDs may end in @s.whatsapp.net and may include a linked-device
    -- suffix such as :26.  Neither suffix is part of the phone number.
    local_part := split_part(split_part(btrim(p_value), '@', 1), ':', 1);
    digits := regexp_replace(local_part, '[^0-9]', '', 'g');

    if length(digits) = 12 and left(digits, 2) = '91' then
        digits := right(digits, 10);
    elsif length(digits) = 11 and left(digits, 1) = '0' then
        digits := right(digits, 10);
    end if;

    if length(digits) = 10 and digits ~ '^[6-9][0-9]{9}$' then
        return digits;
    end if;
    return null;
end;
$$;

create or replace function public.market_clean_person_name(p_value text)
returns text
language plpgsql
immutable
security invoker
set search_path = public
as $$
declare
    cleaned text := btrim(coalesce(p_value, ''));
begin
    if cleaned = '' or lower(cleaned) = 'unknown' then
        return null;
    end if;
    if cleaned ~ '^\+?[0-9xX[:space:]().-]{7,}$' then
        return null;
    end if;

    cleaned := regexp_replace(
        cleaned,
        '[[:space:]]*\([^)]*(\+?[0-9]|[xX]{2,})[^)]*\)[[:space:]]*',
        ' ',
        'g'
    );
    cleaned := regexp_replace(
        cleaned,
        '[[:space:]]*\+?[0-9xX][0-9xX[:space:]().-]{7,}[[:space:]]*',
        ' ',
        'g'
    );
    cleaned := btrim(regexp_replace(cleaned, '[[:space:]]+', ' ', 'g'), ' -');

    if cleaned = '' or cleaned ~ '^\+?[0-9xX[:space:]().-]{7,}$' then
        return null;
    end if;
    return cleaned;
end;
$$;

create or replace function public.market_name_key(p_value text)
returns text
language sql
immutable
security invoker
set search_path = public
as $$
    select nullif(
        btrim(regexp_replace(lower(coalesce(p_value, '')), '[^[:alnum:]]+', ' ', 'g')),
        ''
    );
$$;

create or replace function public.market_is_group(p_group_name text)
returns boolean
language sql
immutable
security invoker
set search_path = public
as $$
    select coalesce(btrim(p_group_name), '') not in ('', 'seed', 'seed-bot', 'status@broadcast', 'broadcast')
       and coalesce(p_group_name, '') not like '%@s.whatsapp.net'
       and coalesce(p_group_name, '') not like '%@lid'
       and coalesce(p_group_name, '') not like '%@newsletter'
       and coalesce(p_group_name, '') not like '%@broadcast';
$$;

create index if not exists idx_parsed_output_tenant_created_id
    on public.parsed_output (tenant_id, created_at desc, id desc);

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
      and public.market_is_group(r.group_name)
), source_rows as (
    select
        source_inputs.*,
        public.market_name_key(display_name) as name_key
    from source_inputs
), identity_links as (
    -- Historical rows often have only a WhatsApp profile name.  When that
    -- normalized name has been observed with exactly one phone in the same
    -- market window, safely fold the name-only history into that phone.  A
    -- name seen with multiple phones is deliberately left unresolved.
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
      and public.market_is_group(r.group_name)
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
            -- These parser columns roll out independently of Market Inbox.
            -- JSON lookup keeps this function compatible both before and
            -- after those optional columns exist in parsed_output.
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

revoke all on function public.market_normalize_phone(text) from public;
revoke all on function public.market_clean_person_name(text) from public;
revoke all on function public.market_name_key(text) from public;
revoke all on function public.market_is_group(text) from public;
revoke all on function public.get_market_brokers_feed(integer, integer, integer, uuid) from public;
revoke all on function public.get_market_observations_feed(integer, integer, text, text, uuid) from public;

grant execute on function public.market_normalize_phone(text) to service_role;
grant execute on function public.market_clean_person_name(text) to service_role;
grant execute on function public.market_name_key(text) to service_role;
grant execute on function public.market_is_group(text) to service_role;
grant execute on function public.get_market_brokers_feed(integer, integer, integer, uuid) to service_role;
grant execute on function public.get_market_observations_feed(integer, integer, text, text, uuid) to service_role;
