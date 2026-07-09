-- ============================================================================
-- Postgres functions: rebuild observation graph, broker graph, observations feed
-- Ported from SQLite storage for Supabase-native execution
-- ============================================================================

-- ensure pgcrypto for sha256
create extension if not exists pgcrypto with schema extensions;

-- ── Helper: observation fingerprint (SHA256 of broker + content parts) ────────
create or replace function public.obs_fingerprint(
    p_broker_name text, p_profile_name text, p_broker_phone text,
    p_intent text, p_bhk text, p_price numeric,
    p_building_name text, p_micro_market text, p_location_raw text
) returns text
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
    broker_name text := coalesce(nullif(btrim(coalesce(p_broker_name, p_profile_name, '')), ''), '');
    phone_digits text := coalesce(regexp_replace(coalesce(p_broker_phone, ''), '\D', '', 'g'), '');
    broker_part text;
    content_part text;
    raw text;
begin
    broker_part := lower(broker_name) || '::' || phone_digits;
    content_part := lower(coalesce(p_intent, '')) || '::'
                    || lower(coalesce(p_bhk, '')) || '::'
                    || coalesce(round(p_price)::text, '0') || '::'
                    || lower(coalesce(p_building_name, '')) || '::'
                    || lower(coalesce(p_micro_market, '')) || '::'
                    || lower(coalesce(p_location_raw, ''));
    raw := broker_part || '||' || content_part;
    return encode(extensions.digest(raw, 'sha256'), 'hex');
end;
$$;

-- ── Helper: backfill intent from raw text ────────────────────────────────────
create or replace function public.backfill_intent(raw_text text, current_intent text)
returns text
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
    lower_text text;
begin
    if current_intent is not null and btrim(current_intent) != '' then
        return current_intent;
    end if;
    lower_text := lower(coalesce(raw_text, ''));
    if lower_text ~ '\bfor\s+sale\b' or lower_text ~ '\bonsale\b' then
        return 'SELL';
    end if;
    if lower_text ~ '\b(?:for\s+)?rent\b' or lower_text ~ '\bleased?\b' then
        return 'RENT';
    end if;
    return current_intent;
end;
$$;

-- ── Helper: backfill building name from raw text ─────────────────────────────
create or replace function public.backfill_building_name(raw_text text, current_name text)
returns text
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
    first_line text;
    m text[];
begin
    if current_name is not null and btrim(current_name) != '' then
        return current_name;
    end if;
    first_line := split_part(coalesce(raw_text, ''), E'\n', 1);
    -- Match quoted text
    m := regexp_matches(first_line, '["\u201C\u201D]([^"\u201C\u201D]{3,50})["\u201C\u201D]');
    if m is not null and array_length(m, 1) > 0 then
        if m[1] !~* '(price|lac|cr|sqft|floor|contact|call|property|available|building|tower)' then
            return btrim(m[1], '_ ');
        end if;
    end if;
    -- Match markdown-wrapped
    m := regexp_matches(raw_text, '_"([A-Z][A-Za-z0-9\s\-.]{3,50})"_');
    if m is not null and array_length(m, 1) > 0 then
        return btrim(m[1]);
    end if;
    -- First capitalized multi-word (2-4 words) on line 1
    m := regexp_matches(first_line, '(?:^|\s)([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})(?:\s|$)');
    if m is not null and array_length(m, 1) > 0 then
        if m[1] !~* '(price|lac|cr|sqft|call|contact|property|please|kindly|available|required)'
           and length(m[1]) >= 5 and length(m[1]) <= 40 then
            return m[1];
        end if;
    end if;
    return current_name;
end;
$$;

-- ── Helper: backfill micro_market from raw text ──────────────────────────────
create or replace function public.backfill_location(raw_text text, current_market text, current_loc_raw text, out micro_market text, out location_raw text)
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
    lower_text text;
    loc_patterns text[];
    pat text;
    m text[];
begin
    micro_market := current_market;
    location_raw := current_loc_raw;

    if current_market is not null and btrim(current_market) != '' then
        return;
    end if;
    if current_loc_raw is not null and btrim(current_loc_raw) != '' then
        return;
    end if;

    lower_text := lower(coalesce(raw_text, ''));
    loc_patterns := array[
        'andheri\s*(?:\(\s*[ew]\s*\)|\s+(?:east|west))?',
        'bandra\s*(?:east|west)?',
        'juhu', 'khar\s*(?:east|west)?', 'dadar',
        'worli', 'malad\s*(?:east|west)?', 'powai',
        'goregaon\s*(?:east|west)?', 'kandivali\s*(?:east|west)?',
        'borivali\s*(?:east|west)?', 'dombivli', 'thane',
        'navi\s+mumbai', 'nerul', 'vashi', 'panvel',
        'chembur', 'kurla', 'ghatkopar', 'vile\s+parle',
        'lower\s+para?l', 'prabhadevi', 'marine\s+lines?',
        'colaba', 'churchgate', 'fort', 'byculla',
        'mahim', 'matunga', 'sion', 'wadala',
        'dahisar', 'mira\s+road', 'bhayandar',
        'vasai', 'virar', 'kalyan', 'ambernath',
        'badlapur', 'ulhasnagar'
    ];

    foreach pat in array loc_patterns loop
        m := regexp_matches(lower_text, pat, 'i');
        if m is not null and array_length(m, 1) > 0 then
            location_raw := initcap(m[1]);
            -- Normalize: "andheri (w)" -> "Andheri West"
            micro_market := regexp_replace(
                initcap(m[1]),
                '\(\s*[EW]\s*\)',
                case when upper(substring(m[1] from '\(([EW])\)')) = 'E' then 'East' else 'West' end
            );
            return;
        end if;
    end loop;
end;
$$;

-- ── Helper: generate summary_title ──────────────────────────────────────────
create or replace function public.make_observation_title(
    raw_text text,
    p_intent text,
    p_bhk text,
    p_price numeric,
    p_price_unit text,
    p_building_name text,
    p_micro_market text,
    p_location_raw text
) returns text
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
    parts text[] := '{}';
    lower_text text := lower(coalesce(raw_text, ''));
    tt text;
    pt text;
    loc text;
    bldg text;
    price_label text;
begin
    if lower_text ~ '\bfor\s+sale\b' or lower_text ~ '\bonsale\b' then
        tt := 'Sale';
    elsif lower_text ~ '\b(?:for\s+)?rent\b' then
        tt := 'Rent';
    elsif lower_text ~ '\bleased?\b' then
        tt := 'Lease';
    end if;
    if tt is not null then parts := array_append(parts, tt); end if;

    if lower_text ~ '\bflat\b' then pt := 'Flat';
    elsif lower_text ~ '\boffice\b' then pt := 'Office';
    elsif lower_text ~ '\bshop\b' then pt := 'Shop';
    elsif lower_text ~ '\bshowroom\b' then pt := 'Showroom';
    elsif lower_text ~ '\bbungalow\b' then pt := 'Bungalow';
    elsif lower_text ~ '\bvilla\b' then pt := 'Villa';
    elsif lower_text ~ '\bgodown\b' then pt := 'Godown';
    elsif lower_text ~ '\bwarehouse\b' then pt := 'Warehouse';
    elsif lower_text ~ '\bcommercial\b' then pt := 'Commercial';
    end if;
    if pt is not null then parts := array_append(parts, pt); end if;

    loc := coalesce(p_micro_market, '');
    if loc = '' and p_location_raw is not null then loc := p_location_raw; end if;
    if loc != '' then parts := array_append(parts, initcap(loc)); end if;

    bldg := coalesce(p_building_name, '');
    if bldg != '' then parts := array_append(parts, bldg); end if;

    if p_price is not null then
        price_label := '\u20B9' || p_price::text || ' ' || coalesce(p_price_unit, '');
        parts := array_append(parts, btrim(price_label));
    end if;

    if array_length(parts, 1) > 0 then
        return array_to_string(parts, ' | ');
    end if;
    return '';
end;
$$;

-- ── Helper: broker identity key ──────────────────────────────────────────────
create or replace function public.broker_identity_key(p_name text, p_phone text)
returns text
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
    digits text;
begin
    digits := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
    if length(digits) >= 10 then
        return 'phone:' || right(digits, 10);
    end if;
    if p_name is not null and btrim(p_name) != '' then
        return 'name:' || lower(regexp_replace(btrim(p_name), '\s+', ' ', 'g'));
    end if;
    return null;
end;
$$;

-- ── Helper: broker role ──────────────────────────────────────────────────────
create or replace function public.broker_role(p_message_type text, p_intent text)
returns text
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
begin
    if p_intent in ('SELL', 'RENT', 'COMMERCIAL', 'PRE-LAUNCH') then return 'listing'; end if;
    if p_intent in ('BUY', 'RENTAL_SEEKER') then return 'requirement'; end if;
    if p_message_type in ('SELLER', 'RENTAL', 'COMMERCIAL_SALE', 'COMMERCIAL_RENTAL', 'PRE_LAUNCH') then return 'listing'; end if;
    if p_message_type in ('REQUIREMENT', 'RENTAL_SEEKER') then return 'requirement'; end if;
    return 'unknown';
end;
$$;

-- ── Helper: is generic broker name ───────────────────────────────────────────
create or replace function public.is_generic_name(p_name text)
returns boolean
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
begin
    return lower(btrim(p_name)) in (
        'real estate', 'property', 'properties', 'realtor', 'broker', 'agent',
        'consultant', 'advisor', 'realty', 'estate', 'group', 'team'
    );
end;
$$;

-- ── Helper: extract name from message signature ──────────────────────────────
create or replace function public.extract_name_from_message(p_message text)
returns text
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
    m text[];
begin
    if p_message is null then return null; end if;
    m := regexp_matches(p_message, '(\d{10,12})\s*\n\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)');
    if m is not null and array_length(m, 1) >= 2 then return btrim(m[2]); end if;
    m := regexp_matches(p_message, '(\d{10,12})\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s*$');
    if m is not null and array_length(m, 1) >= 2 then return btrim(m[2]); end if;
    return null;
end;
$$;

-- ── Helper: effective broker name from a parsed row ─────────────────────────
create or replace function public.effective_broker_name(
    p_broker_name text, p_profile_name text, p_sender text, p_message text
) returns text
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
    cand text;
begin
    cand := coalesce(nullif(btrim(p_broker_name), ''), nullif(btrim(p_profile_name), ''), nullif(btrim(p_sender), ''));
    if cand is not null and not public.is_generic_name(cand) then
        return cand;
    end if;
    return public.extract_name_from_message(p_message);
end;
$$;


-- ══════════════════════════════════════════════════════════════════════════════
-- FUNCTION: rebuild_observation_graph()
-- Rebuilds observations + observation_evidence from parsed_output + raw_messages
-- ══════════════════════════════════════════════════════════════════════════════
create or replace function public.rebuild_observation_graph()
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
    rec record;
    fp text;
    bk text;
    backfilled_intent text;
    backfilled_building text;
    backfilled_market text;
    backfilled_loc_raw text;
    title text;
    seen_ts timestamptz;
    obs_id bigint;
    evidence_type text;
    source_conv text;
    total_obs int := 0;
    total_evidence int := 0;
begin
    truncate table observation_evidence;
    truncate table observations;

    for rec in
        select p.id as parsed_id, p.raw_message_id, p.intent, p.bhk,
               p.price, p.price_unit, p.building_name, p.micro_market,
               p.location_raw, p.broker_name, p.broker_phone, p.profile_name,
               p.summary_title, p.tenant_id,
               r.group_name, r.timestamp, r.sender_jid, r.message, r.sender
        from parsed_output p
        join raw_messages r on r.id = p.raw_message_id
        where coalesce(p.broker_name, p.profile_name, r.sender, '') != ''
        order by p.id
    loop
        backfilled_intent := public.backfill_intent(rec.message, rec.intent);
        backfilled_building := public.backfill_building_name(rec.message, rec.building_name);
        select m, l into backfilled_market, backfilled_loc_raw
        from public.backfill_location(rec.message, rec.micro_market, rec.location_raw)
        as (micro_market text, location_raw text);

        title := public.make_observation_title(
            rec.message, backfilled_intent, rec.bhk,
            rec.price, rec.price_unit,
            backfilled_building, backfilled_market, backfilled_loc_raw
        );

        fp := public.obs_fingerprint(
            rec.broker_name, rec.profile_name, rec.broker_phone,
            backfilled_intent, rec.bhk, rec.price,
            backfilled_building, backfilled_market, backfilled_loc_raw
        );

        bk := regexp_replace(coalesce(rec.broker_phone, ''), '\D', '', 'g');
        seen_ts := coalesce(rec.timestamp, now());

        insert into observations (fingerprint, broker_key, summary_title,
            intent, bhk, price, price_unit, building_name, micro_market,
            location_raw, first_seen, last_seen, times_seen, tenant_id)
        values (fp, bk, title, backfilled_intent, rec.bhk, rec.price,
            rec.price_unit, backfilled_building, backfilled_market,
            backfilled_loc_raw, seen_ts, seen_ts, 1, rec.tenant_id)
        on conflict (broker_key, fingerprint) do update set
            times_seen = observations.times_seen + 1,
            last_seen = greatest(observations.last_seen, excluded.last_seen),
            first_seen = least(observations.first_seen, excluded.first_seen),
            summary_title = case
                when excluded.last_seen > observations.last_seen
                then excluded.summary_title
                else observations.summary_title
            end
        returning id into obs_id;

        if btrim(coalesce(rec.group_name, '')) = '' and btrim(coalesce(rec.sender_jid, '')) != '' then
            evidence_type := 'dm';
            source_conv := rec.sender_jid;
        elsif lower(coalesce(rec.group_name, '')) ~ 'broadcast' then
            evidence_type := 'broadcast';
            source_conv := rec.group_name;
        else
            evidence_type := 'group';
            source_conv := coalesce(rec.group_name, '');
        end if;

        insert into observation_evidence
            (observation_id, raw_message_id, parsed_id, evidence_type, source_conversation, seen_at)
        values (obs_id, rec.raw_message_id, rec.parsed_id, evidence_type, source_conv, seen_ts)
        on conflict (observation_id, raw_message_id) do nothing;

        total_evidence := total_evidence + 1;
    end loop;

    select count(*) into total_obs from observations;

    return jsonb_build_object('observations', total_obs, 'evidence', total_evidence);
end;
$$;


-- ══════════════════════════════════════════════════════════════════════════════
-- FUNCTION: rebuild_broker_graph()
-- Full rebuild: brokers + broker_observations + aliases + phones + stats
-- ══════════════════════════════════════════════════════════════════════════════
create or replace function public.rebuild_broker_graph()
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
    total_brokers int := 0;
    total_obs int := 0;
    existing_keys text[];
    remaining_keys text[];
begin
    -- Snapshot existing keys for stale detection
    select array_agg(identity_key) into existing_keys from brokers;

    -- Clear derived tables
    delete from broker_building_stats;
    delete from broker_market_stats;
    delete from broker_observations;
    delete from broker_aliases;
    delete from broker_phones;

    -- ── Phase 1: Source data with identity_key and effective_name ──────────
    create temp table _broker_source on commit drop as
    select p.id as parsed_id, p.raw_message_id, p.message_type, p.intent,
           p.broker_name, p.broker_phone, p.profile_name,
           p.micro_market,
           coalesce(rd.building_name, p.building_name) as building_name,
           coalesce(rd.landmark_name, p.landmark_name) as landmark_name,
           p.price, p.bhk, p.created_at,
           r.group_name, r.sender, r.message, r.timestamp,
           r.sender_jid, p.tenant_id,
           public.broker_identity_key(
               coalesce(p.broker_name, p.profile_name, r.sender),
               p.broker_phone
           ) as identity_key,
           public.effective_broker_name(p.broker_name, p.profile_name, r.sender, r.message) as effective_name
    from parsed_output p
    join raw_messages r on r.id = p.raw_message_id
    left join resolver_decisions rd on rd.parsed_id = p.id
    where coalesce(p.broker_name, p.profile_name, r.sender, '') != '';

    delete from _broker_source where identity_key is null;

    -- ── Phase 2: Upsert broker records ─────────────────────────────────────
    with grouped as (
        select
            identity_key,
            (mode() within group (order by effective_name)) as canonical_name,
            (mode() within group (order by
                case when length(regexp_replace(coalesce(broker_phone, ''), '\D', '', 'g')) >= 10
                then right(regexp_replace(coalesce(broker_phone, ''), '\D', '', 'g'), 10)
                else null end
            )) as primary_phone,
            min(coalesce(timestamp, created_at)) as first_seen_val,
            max(coalesce(timestamp, created_at)) as last_seen_val,
            count(*) as obs_count,
            count(*) filter (where public.broker_role(message_type, intent) = 'listing') as listing_c,
            count(*) filter (where public.broker_role(message_type, intent) = 'requirement') as req_c,
            count(*) filter (where intent in ('RENT', 'RENTAL_SEEKER') or message_type in ('RENTAL', 'RENTAL_SEEKER')) as rental_c,
            count(*) filter (where intent = 'COMMERCIAL' or message_type in ('COMMERCIAL_SALE', 'COMMERCIAL_RENTAL')) as commercial_c,
            count(distinct group_name) as group_count,
            count(distinct micro_market) as market_count,
            count(distinct coalesce(building_name, ''))
                filter (where building_name is not null and btrim(building_name) != '' and btrim(building_name) != '-')
                as building_c,
            count(distinct date(coalesce(timestamp, created_at)))
                filter (where coalesce(timestamp, created_at) >= now() - interval '30 days')
                as active_days_30
        from _broker_source
        group by identity_key
    )
    insert into brokers (identity_key, canonical_name, primary_phone,
        first_seen_at, last_seen_at, observation_count, listing_count,
        requirement_count, rental_count, commercial_count,
        group_count, market_count, building_count, active_days_30, updated_at)
    select identity_key, canonical_name, primary_phone,
           first_seen_val, last_seen_val, obs_count,
           listing_c, req_c, rental_c, commercial_c,
           group_count, market_count, building_c, active_days_30, now()
    from grouped
    on conflict (identity_key) do update set
        canonical_name = excluded.canonical_name,
        primary_phone = excluded.primary_phone,
        first_seen_at = least(brokers.first_seen_at, excluded.first_seen_at),
        last_seen_at = greatest(brokers.last_seen_at, excluded.last_seen_at),
        observation_count = excluded.observation_count,
        listing_count = excluded.listing_count,
        requirement_count = excluded.requirement_count,
        rental_count = excluded.rental_count,
        commercial_count = excluded.commercial_count,
        group_count = excluded.group_count,
        market_count = excluded.market_count,
        building_count = excluded.building_count,
        active_days_30 = excluded.active_days_30,
        updated_at = now()
    returning id;

    get diagnostics total_brokers = row_count;

    -- ── Phase 3: broker_observations ───────────────────────────────────────
    insert into broker_observations (broker_id, parsed_id, raw_message_id, role,
        message_type, group_name, micro_market, building_name, landmark_name,
        price, bhk, seen_at)
    select b.id, s.parsed_id, s.raw_message_id,
           public.broker_role(s.message_type, s.intent),
           s.message_type, coalesce(s.group_name, ''), s.micro_market,
           s.building_name, s.landmark_name, s.price, s.bhk,
           coalesce(s.timestamp, s.created_at)
    from _broker_source s
    join brokers b on b.identity_key = s.identity_key;

    get diagnostics total_obs = row_count;

    -- ── Phase 4: broker_aliases ────────────────────────────────────────────
    insert into broker_aliases (broker_id, alias, observation_count, first_seen_at, last_seen_at)
    select b.id, s.effective_name, count(*)::int,
           min(coalesce(s.timestamp, s.created_at)),
           max(coalesce(s.timestamp, s.created_at))
    from _broker_source s
    join brokers b on b.identity_key = s.identity_key
    where s.effective_name is not null
    group by b.id, s.effective_name;

    -- ── Phase 5: broker_phones ─────────────────────────────────────────────
    insert into broker_phones (broker_id, phone, observation_count, first_seen_at, last_seen_at)
    select b.id,
           right(regexp_replace(coalesce(s.broker_phone, ''), '\D', '', 'g'), 10),
           count(*)::int,
           min(coalesce(s.timestamp, s.created_at)),
           max(coalesce(s.timestamp, s.created_at))
    from _broker_source s
    join brokers b on b.identity_key = s.identity_key
    where length(regexp_replace(coalesce(s.broker_phone, ''), '\D', '', 'g')) >= 10
    group by b.id, right(regexp_replace(coalesce(s.broker_phone, ''), '\D', '', 'g'), 10);

    -- ── Phase 6: broker_market_stats ───────────────────────────────────────
    insert into broker_market_stats (broker_id, micro_market, observation_count,
        listing_count, requirement_count, avg_ticket, last_seen_at)
    select b.id, s.micro_market, count(*)::int,
           count(*) filter (where public.broker_role(s.message_type, s.intent) = 'listing')::int,
           count(*) filter (where public.broker_role(s.message_type, s.intent) = 'requirement')::int,
           avg(s.price) filter (where s.price is not null),
           max(coalesce(s.timestamp, s.created_at))
    from _broker_source s
    join brokers b on b.identity_key = s.identity_key
    where s.micro_market is not null and btrim(s.micro_market) != ''
    group by b.id, s.micro_market;

    -- ── Phase 7: broker_building_stats ─────────────────────────────────────
    insert into broker_building_stats (broker_id, building_name, observation_count,
        listing_count, requirement_count, avg_ticket, last_seen_at)
    select b.id, s.building_name, count(*)::int,
           count(*) filter (where public.broker_role(s.message_type, s.intent) = 'listing')::int,
           count(*) filter (where public.broker_role(s.message_type, s.intent) = 'requirement')::int,
           avg(s.price) filter (where s.price is not null),
           max(coalesce(s.timestamp, s.created_at))
    from _broker_source s
    join brokers b on b.identity_key = s.identity_key
    where s.building_name is not null and btrim(s.building_name) != '' and btrim(s.building_name) != '-'
    group by b.id, s.building_name;

    -- ── Phase 8: Remove stale brokers ──────────────────────────────────────
    if existing_keys is not null then
        select array(
            select unnest(existing_keys)
            except
            select identity_key from _broker_source group by identity_key
        ) into remaining_keys;
        if remaining_keys is not null and array_length(remaining_keys, 1) > 0 then
            delete from brokers where identity_key = any(remaining_keys);
        end if;
    end if;

    return jsonb_build_object('brokers', total_brokers, 'observations', total_obs);
end;
$$;


-- ══════════════════════════════════════════════════════════════════════════════
-- FUNCTION: get_observations_feed()
-- Returns observations with evidence as a JSON array
-- ══════════════════════════════════════════════════════════════════════════════
create or replace function public.get_observations_feed(
    p_limit int default 50,
    p_offset int default 0,
    p_broker_key text default '',
    p_intent text default '',
    p_tenant_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
    result jsonb;
begin
    select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into result
    from (
        select o.id, o.fingerprint, o.broker_key, o.summary_title,
               o.intent, o.bhk, o.price, o.price_unit,
               o.building_name, o.micro_market, o.location_raw,
               o.first_seen, o.last_seen, o.times_seen,
               coalesce(
                   (select jsonb_agg(
                        jsonb_build_object(
                            'type', oe.evidence_type,
                            'source', oe.source_conversation,
                            'seen_at', oe.seen_at
                        )
                    ) from observation_evidence oe
                    where oe.observation_id = o.id),
                   '[]'::jsonb
               ) as evidence_list,
               (select oe2.raw_message_id from observation_evidence oe2
                where oe2.observation_id = o.id
                order by oe2.seen_at desc limit 1) as latest_raw_message_id,
               (select oe3.parsed_id from observation_evidence oe3
                where oe3.observation_id = o.id
                order by oe3.seen_at desc limit 1) as latest_parsed_id,
               (select rm.message from observation_evidence oe4
                join raw_messages rm on rm.id = oe4.raw_message_id
                where oe4.observation_id = o.id
                order by oe4.seen_at desc limit 1) as raw_message,
               (select rm.sender from observation_evidence oe5
                join raw_messages rm on rm.id = oe5.raw_message_id
                where oe5.observation_id = o.id
                order by oe5.seen_at desc limit 1) as raw_sender
        from observations o
        where (p_broker_key = '' or o.broker_key = p_broker_key)
          and (p_intent = '' or o.intent = upper(p_intent))
          and (p_tenant_id is null or o.tenant_id = p_tenant_id)
        order by o.last_seen desc
        limit p_limit
        offset p_offset
    ) t;

    return result;
end;
$$;


-- ══════════════════════════════════════════════════════════════════════════════
-- FUNCTION: get_brokers_feed()
-- Returns brokers with aggregated stats
-- ══════════════════════════════════════════════════════════════════════════════
create or replace function public.get_brokers_feed(
    p_limit int default 50,
    p_offset int default 0,
    p_min_observations int default 1,
    p_tenant_id uuid default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
    result jsonb;
begin
    select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) into result
    from (
        select b.*,
               coalesce(
                   (select jsonb_agg(jsonb_build_object('alias', ba.alias, 'count', ba.observation_count)
                    from broker_aliases ba where ba.broker_id = b.id),
                   '[]'::jsonb
               ) as aliases,
               coalesce(
                   (select jsonb_agg(jsonb_build_object('phone', bp.phone, 'count', bp.observation_count)
                    from broker_phones bp where bp.broker_id = b.id),
                   '[]'::jsonb
               ) as phones,
               coalesce(
                   (select jsonb_agg(jsonb_build_object('micro_market', bms.micro_market, 'count', bms.observation_count,
                        'listing_count', bms.listing_count, 'avg_ticket', bms.avg_ticket)
                    from broker_market_stats bms where bms.broker_id = b.id),
                   '[]'::jsonb
               ) as market_stats,
               coalesce(
                   (select jsonb_agg(jsonb_build_object('building_name', bbs.building_name, 'count', bbs.observation_count,
                        'listing_count', bbs.listing_count, 'avg_ticket', bbs.avg_ticket)
                    from broker_building_stats bbs where bbs.broker_id = b.id),
                   '[]'::jsonb
               ) as building_stats
        from brokers b
        where b.observation_count >= p_min_observations
          and b.is_hidden = false
          and (p_tenant_id is null or b.tenant_id = p_tenant_id)
        order by b.observation_count desc, b.last_seen_at desc
        limit p_limit
        offset p_offset
    ) t;

    return result;
end;
$$;


-- ══════════════════════════════════════════════════════════════════════════════
-- Add missing indexes on observations / observation_evidence
-- ══════════════════════════════════════════════════════════════════════════════
create index if not exists idx_observations_broker_key on observations(broker_key);
create index if not exists idx_observations_last_seen on observations(last_seen desc);
create index if not exists idx_observations_tenant on observations(tenant_id);
create index if not exists idx_observation_evidence_observation on observation_evidence(observation_id);
create index if not exists idx_observation_evidence_seen on observation_evidence(seen_at desc);

-- ══════════════════════════════════════════════════════════════════════════════
-- Grants
-- ══════════════════════════════════════════════════════════════════════════════
do $$
declare
    funcs text[] := array[
        'obs_fingerprint(text,text,text,text,text,numeric,text,text,text)',
        'backfill_intent(text,text)',
        'backfill_building_name(text,text)',
        'backfill_location(text,text,text)',
        'make_observation_title(text,text,text,numeric,text,text,text,text)',
        'broker_identity_key(text,text)',
        'broker_role(text,text)',
        'is_generic_name(text)',
        'extract_name_from_message(text)',
        'effective_broker_name(text,text,text,text)',
        'rebuild_observation_graph()',
        'rebuild_broker_graph()',
        'get_observations_feed(int,int,text,text,uuid)',
        'get_brokers_feed(int,int,int,uuid)'
    ];
    f text;
begin
    foreach f in array funcs loop
        execute format('revoke all on function public.%s from public', f);
        execute format('grant execute on function public.%s to service_role', f);
    end loop;
end;
$$;
