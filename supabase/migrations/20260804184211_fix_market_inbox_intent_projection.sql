-- The typed requirement tables keep transaction_type as sale/rent, while the
-- previous feed used that field to decide listing vs requirement. Re-project
-- the existing item-aware feed using raw_message_id + listing_index, which is
-- the stable provenance pair across the typed tables.

alter function public.get_market_observations_feed(integer, integer, text, text, uuid)
  rename to get_market_observations_feed_legacy;

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
with legacy as (
    select value as item
      from jsonb_array_elements(
        public.get_market_observations_feed_legacy(
          500, 0, p_broker_key, '', p_tenant_id
        )
      )
), projected as (
    select item || case
      when exists (
        select 1
          from (
            select raw_message_id, listing_index, transaction_type
              from public.residential_sale_requirements
            union all select raw_message_id, listing_index, transaction_type from public.residential_rent_requirements
            union all select raw_message_id, listing_index, transaction_type from public.commercial_sale_requirements
            union all select raw_message_id, listing_index, transaction_type from public.commercial_rent_requirements
          ) requirements
         where requirements.raw_message_id = nullif(item->>'latest_raw_message_id', '')::bigint
           and requirements.listing_index = nullif(item->>'listing_index', '')::integer
      ) then jsonb_build_object(
        'observation_type', 'REQUIREMENT',
        'intent', 'BUY'
      )
      else jsonb_build_object(
        'observation_type', 'LISTING',
        'intent', case when lower(coalesce(item->>'transaction_type', '')) = 'rent' then 'RENT' else 'SELL' end
      )
    end as item
      from legacy
), filtered as (
    select item
      from projected
     where nullif(trim(p_intent), '') is null
        or upper(item->>'intent') = upper(p_intent)
        or upper(item->>'transaction_type') = upper(p_intent)
), page as (
    select item
      from filtered
     order by item->>'last_seen' desc nulls last, item->>'id' desc
     limit greatest(least(coalesce(p_limit, 50), 500), 1)
     offset greatest(coalesce(p_offset, 0), 0)
)
select coalesce(jsonb_agg(item order by item->>'last_seen' desc nulls last, item->>'id' desc), '[]'::jsonb)
  from page;
$$;

revoke all on function public.get_market_observations_feed(integer, integer, text, text, uuid) from public, anon, authenticated;
grant execute on function public.get_market_observations_feed(integer, integer, text, text, uuid) to service_role;

notify pgrst, 'reload schema';
