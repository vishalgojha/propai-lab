-- Repair parsed_output locality resolution without touching building aggregates.

create or replace function public.infer_micro_market_from_text(input_text text)
returns text
language plpgsql
immutable
security invoker
set search_path = public
as $$
declare
    normalized text := lower(coalesce(input_text, ''));
    patterns text[] := array[
        '\mandheri\s*\(\s*w\s*\)\M', '\mandheri\s+west\M',
        '\mandheri\s*\(\s*e\s*\)\M', '\mandheri\s+east\M',
        '\mband(?:ra)?\s+west\M', '\mband(?:ra)?\s+east\M',
        '\msantacruz\s+west\M', '\msantacruz\s+east\M',
        '\mkhar\s+west\M', '\mkhar\s+east\M',
        '\mgoregaon\s+west\M', '\mgoregaon\s+east\M',
        '\mmalad\s+west\M', '\mmalad\s+east\M',
        '\mkandivali\s+west\M', '\mkandivali\s+east\M',
        '\mborivali\s+west\M', '\mborivali\s+east\M',
        '\mvile\s+parle\s+west\M', '\mvile\s+parle\s+east\M',
        '\mlower\s+parel\M', '\mnavi\s+mumbai\M', '\mmira\s+road\M',
        '\mmarine\s+lines?\M', '\mcuffe\s+parade\M', '\mwarden\s+road\M',
        '\mpali\s+hill\M', '\mlokhandwala\M', '\moshiwara\M',
        '\mband(?:ra)?\M', '\mandheri\M', '\msantacruz\M', '\mkhar\M',
        '\mjuhu\M', '\mworli\M', '\mparel\M', '\mdadar\M', '\mpowai\M',
        '\mgoregaon\M', '\mmalad\M', '\mkandivali\M', '\mborivali\M',
        '\mchembur\M', '\mkurla\M', '\mghatkopar\M', '\mversova\M',
        '\mvile\s+parle\M', '\mmahalaxmi\M', '\mprabhadevi\M',
        '\mthane\M', '\mdombivli\M', '\mkalyan\M', '\mambernath\M',
        '\mbadlapur\M', '\mulhasnagar\M', '\mnerul\M', '\mvashi\M',
        '\mpanvel\M', '\mdahisar\M', '\mbhayandar\M', '\mvasai\M',
        '\mvirar\M', '\mcolaba\M', '\mchurchgate\M', '\mfort\M',
        '\mbyculla\M', '\mmahim\M', '\mmatunga\M', '\msion\M',
        '\mwadala\M', '\mtardeo\M'
    ];
    markets text[] := array[
        'Andheri West', 'Andheri West', 'Andheri East', 'Andheri East',
        'Bandra West', 'Bandra East', 'Santacruz West', 'Santacruz East',
        'Khar West', 'Khar East', 'Goregaon West', 'Goregaon East',
        'Malad West', 'Malad East', 'Kandivali West', 'Kandivali East',
        'Borivali West', 'Borivali East', 'Vile Parle West', 'Vile Parle East',
        'Lower Parel', 'Navi Mumbai', 'Mira Road', 'Marine Lines',
        'Cuffe Parade', 'Warden Road', 'Pali Hill', 'Lokhandwala',
        'Andheri West', 'Bandra', 'Andheri', 'Santacruz', 'Khar', 'Juhu',
        'Worli', 'Parel', 'Dadar', 'Powai', 'Goregaon', 'Malad', 'Kandivali',
        'Borivali', 'Chembur', 'Kurla', 'Ghatkopar', 'Andheri West',
        'Vile Parle', 'Mahalaxmi', 'Prabhadevi', 'Thane', 'Dombivli', 'Kalyan',
        'Ambernath', 'Badlapur', 'Ulhasnagar', 'Nerul', 'Vashi', 'Panvel',
        'Dahisar', 'Bhayandar', 'Vasai', 'Virar', 'Colaba', 'Churchgate',
        'Fort', 'Byculla', 'Mahim', 'Matunga', 'Sion', 'Wadala', 'Tardeo'
    ];
    idx integer;
begin
    for idx in 1..array_length(patterns, 1) loop
        if normalized ~ patterns[idx] then
            return markets[idx];
        end if;
    end loop;
    return null;
end;
$$;

-- Existing graph rebuilds used to stop as soon as location_raw was present,
-- leaving micro_market null. Preserve location_raw but continue resolution.
create or replace function public.backfill_location(
    raw_text text,
    current_market text,
    current_loc_raw text,
    out micro_market text,
    out location_raw text
)
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
    micro_market := nullif(btrim(current_market), '');
    location_raw := nullif(btrim(current_loc_raw), '');
    if micro_market is not null then
        return;
    end if;

    micro_market := public.infer_micro_market_from_text(location_raw);
    if micro_market is null then
        micro_market := public.infer_micro_market_from_text(raw_text);
    end if;
    if location_raw is null and micro_market is not null then
        location_raw := micro_market;
    end if;
end;
$$;

-- Scan a bounded id window so the production backfill can use short,
-- observable transactions instead of one long table-wide update.
create or replace function public.backfill_parsed_micro_markets_batch(
    after_id bigint default 0,
    batch_limit integer default 2000
)
returns table(scanned integer, updated integer, last_id bigint)
language plpgsql
volatile
security invoker
set search_path = public
as $$
begin
    return query
    with source_rows as materialized (
        select
            p.id,
            p.building_name,
            p.location_raw,
            p.raw_payload,
            r.message
        from public.parsed_output p
        join public.raw_messages r on r.id = p.raw_message_id
        where p.id > after_id
          and nullif(btrim(p.micro_market), '') is null
          and p.intent in ('SELL', 'RENT', 'COMMERCIAL', 'BUY', 'Lease', 'Sale', 'PRE-LAUNCH')
        order by p.id
        limit greatest(1, least(batch_limit, 5000))
    ),
    building_markets as materialized (
        select
            lower(regexp_replace(btrim(canonical_name), '[^a-zA-Z0-9]+', '', 'g')) as building_key,
            min(micro_market) as micro_market
        from public.buildings
        where nullif(btrim(canonical_name), '') is not null
          and nullif(btrim(micro_market), '') is not null
        group by 1
        having count(distinct lower(btrim(micro_market))) = 1
    ),
    resolved as (
        select
            source.id,
            coalesce(
                building.micro_market,
                public.infer_micro_market_from_text(source.location_raw),
                public.infer_micro_market_from_text(source.raw_payload ->> 'full_text'),
                public.infer_micro_market_from_text(source.message)
            ) as micro_market
        from source_rows source
        left join building_markets building
          on nullif(btrim(source.building_name), '') is not null
         and lower(regexp_replace(btrim(source.building_name), '[^a-zA-Z0-9]+', '', 'g')) = building.building_key
    ),
    changed as (
        update public.parsed_output parsed
        set micro_market = resolved.micro_market
        from resolved
        where parsed.id = resolved.id
          and resolved.micro_market is not null
        returning parsed.id
    )
    select
        (select count(*)::integer from source_rows),
        (select count(*)::integer from changed),
        (select max(source_rows.id) from source_rows);
end;
$$;

grant execute on function public.infer_micro_market_from_text(text) to service_role;
revoke all on function public.infer_micro_market_from_text(text) from public, anon, authenticated;
grant execute on function public.backfill_parsed_micro_markets_batch(bigint, integer) to service_role;
revoke all on function public.backfill_parsed_micro_markets_batch(bigint, integer) from public, anon, authenticated;
