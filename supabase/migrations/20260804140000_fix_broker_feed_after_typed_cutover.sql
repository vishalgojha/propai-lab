-- The broker feed RPC still referenced the removed parsed_output compatibility
-- table. Broker aggregates are maintained in brokers, so the feed can render
-- its paginated contactable broker cards without joining the retired model.
create or replace function public.get_market_brokers_feed(
    p_limit integer default 50,
    p_offset integer default 0,
    p_min_observations integer default 1,
    p_tenant_id uuid default null
)
returns jsonb
language sql
stable
as $$
with page as (
    select
        b.id,
        b.identity_key,
        b.primary_phone,
        b.canonical_name,
        b.building_count,
        b.active_days_30,
        b.observation_count,
        b.listing_count,
        b.requirement_count,
        b.first_seen_at,
        b.last_seen_at
    from public.brokers b
    where not b.is_hidden
      and (p_tenant_id is null or b.tenant_id = p_tenant_id)
      and (b.listing_count > 0 or b.requirement_count > 0)
      and coalesce(b.observation_count, b.listing_count + b.requirement_count, 0)
          >= greatest(coalesce(p_min_observations, 1), 1)
    order by b.last_seen_at desc nulls last, b.identity_key asc
    limit greatest(least(coalesce(p_limit, 50), 500), 1)
    offset greatest(coalesce(p_offset, 0), 0)
)
select coalesce(jsonb_agg(
    jsonb_build_object(
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
        'latest_title', '',
        'latest_intent', null,
        'latest_micro_market', null,
        'channels', '[]'::jsonb
    ) order by page.last_seen_at desc nulls last, page.identity_key asc
), '[]'::jsonb)
from page;
$$;

revoke all on function public.get_market_brokers_feed(integer, integer, integer, uuid) from public, anon, authenticated;
grant execute on function public.get_market_brokers_feed(integer, integer, integer, uuid) to service_role;
