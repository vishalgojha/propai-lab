-- The alias cleanup removed parsed_output, but both Market Inbox RPCs still
-- depended on it. Read the canonical unified view instead.

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
with requested as (
    select
        public.market_normalize_phone(p_broker_key) as phone,
        lower(nullif(regexp_replace(p_broker_key, '^name:', '', 'i'), '')) as name
),
source_rows as (
    select
        p.*,
        r.message as raw_message,
        r.sender as raw_sender,
        r.group_name,
        coalesce(r."timestamp", p.created_at, r.created_at) as seen_at
    from public.parsed_output_unified p
    join public.raw_messages r on r.id = p.raw_message_id
    cross join requested q
    where (p_tenant_id is null or p.tenant_id = p_tenant_id)
      and (coalesce(p_intent, '') = '' or upper(coalesce(p.transaction_type, '')) = upper(p_intent))
      and (
          q.phone is null
          or right(regexp_replace(coalesce(p.broker_phone, ''), '\\D', '', 'g'), 10) = q.phone
          or (q.name is not null and lower(coalesce(p.broker_name, '')) like '%' || q.name || '%')
      )
      and p.created_at >= now() - interval '30 days'
), page as (
    select *
    from source_rows
    order by seen_at desc nulls last, id desc
    limit greatest(least(coalesce(p_limit, 50), 500), 1)
    offset greatest(coalesce(p_offset, 0), 0)
)
select coalesce(jsonb_agg(
    jsonb_build_object(
        'id', page.id,
        'fingerprint', 'typed:' || page.id::text,
        'broker_key', 'phone:' || right(regexp_replace(coalesce(page.broker_phone, ''), '\\D', '', 'g'), 10),
        'summary_title', coalesce(page.building_name, page.raw_message, ''),
        'observation_type', case when lower(coalesce(page.transaction_type, '')) in ('buy', 'requirement', 'wanted') then 'REQUIREMENT' else 'LISTING' end,
        'intent', page.transaction_type,
        'asset_type', null,
        'property_type', null,
        'transaction_type', page.transaction_type,
        'bhk', page.bhk,
        'configuration', null,
        'price', page.price,
        'area_sqft', page.area_sqft,
        'building_name', page.building_name,
        'micro_market', page.micro_market,
        'location_raw', page.micro_market,
        'first_seen', page.seen_at,
        'last_seen', page.seen_at,
        'times_seen', 1,
        'evidence_list', case when coalesce(page.group_name, '') <> '' then jsonb_build_array(jsonb_build_object('type', 'group', 'source', page.group_name, 'seen_at', page.seen_at)) else '[]'::jsonb end,
        'latest_raw_message_id', page.raw_message_id,
        'latest_parsed_id', page.id,
        'raw_message', coalesce(page.raw_message, ''),
        'raw_sender', coalesce(page.raw_sender, page.broker_name, ''),
        'broker_name', page.broker_name,
        'broker_phone', page.broker_phone
    ) order by page.seen_at desc nulls last, page.id desc
), '[]'::jsonb)
from page;
$$;

revoke all on function public.get_market_observations_feed(integer, integer, text, text, uuid) from public, anon, authenticated;
grant execute on function public.get_market_observations_feed(integer, integer, text, text, uuid) to service_role;

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
with page as (
    select b.*
    from public.brokers b
    where not b.is_hidden
      and (p_tenant_id is null or b.tenant_id = p_tenant_id)
      and (b.listing_count > 0 or b.requirement_count > 0)
      and coalesce(b.observation_count, b.listing_count + b.requirement_count, 0) >= greatest(coalesce(p_min_observations, 1), 1)
    order by b.last_seen_at desc nulls last, b.identity_key asc
    limit greatest(least(coalesce(p_limit, 50), 500), 1)
    offset greatest(coalesce(p_offset, 0), 0)
), details as (
    select
        p.tenant_id,
        right(regexp_replace(coalesce(p.broker_phone, ''), '\\D', '', 'g'), 10) as phone,
        array_agg(distinct p.micro_market) filter (where nullif(btrim(p.micro_market), '') is not null) as localities,
        max(p.micro_market) filter (where nullif(btrim(p.micro_market), '') is not null) as latest_locality,
        max(p.building_name) filter (where nullif(btrim(p.building_name), '') is not null) as latest_building
    from public.parsed_output_unified p
    where p.created_at >= now() - interval '30 days'
      and nullif(right(regexp_replace(coalesce(p.broker_phone, ''), '\\D', '', 'g'), 10), '') is not null
    group by p.tenant_id, right(regexp_replace(coalesce(p.broker_phone, ''), '\\D', '', 'g'), 10)
)
select coalesce(jsonb_agg(jsonb_build_object(
    'id', page.identity_key,
    'identity_key', page.identity_key,
    'primary_phone', coalesce(page.primary_phone, page.identity_key),
    'canonical_name', coalesce(page.canonical_name, page.primary_phone, 'Unknown broker'),
    'building_count', coalesce(page.building_count, 0),
    'active_days_30', coalesce(page.active_days_30, 0),
    'observation_count', coalesce(page.observation_count, page.listing_count + page.requirement_count, 0),
    'listing_count', coalesce(page.listing_count, 0),
    'requirement_count', coalesce(page.requirement_count, 0),
    'obs_count', coalesce(page.observation_count, page.listing_count + page.requirement_count, 0),
    'last_active', page.last_seen_at,
    'first_seen', page.first_seen_at,
    'group_evidence_count', 0,
    'dm_evidence_count', 0,
    'unique_channel_count', 0,
    'latest_title', coalesce(details.latest_building, ''),
    'latest_intent', null,
    'latest_micro_market', details.latest_locality,
    'specialty_localities', coalesce(to_jsonb(details.localities), '[]'::jsonb),
    'specialty_property_types', '[]'::jsonb,
    'channels', '[]'::jsonb
) order by page.last_seen_at desc nulls last, page.identity_key asc), '[]'::jsonb)
from page
left join details on details.tenant_id = page.tenant_id
    and details.phone = right(regexp_replace(coalesce(page.primary_phone, ''), '\\D', '', 'g'), 10);
$$;

revoke all on function public.get_market_brokers_feed(integer, integer, integer, uuid) from public, anon, authenticated;
grant execute on function public.get_market_brokers_feed(integer, integer, integer, uuid) to service_role;
