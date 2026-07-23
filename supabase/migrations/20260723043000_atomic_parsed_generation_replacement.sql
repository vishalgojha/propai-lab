-- Historical multi-listing reparses create a complete new parsed generation
-- before retiring the old one.  Keep the retirement atomic: a network error
-- or missing dependency must never leave half of the old generation deleted.

create or replace function public.discard_parsed_generation(
    p_tenant_id uuid,
    p_parsed_ids bigint[]
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    v_requested integer := coalesce(cardinality(p_parsed_ids), 0);
    v_owned integer;
begin
    if p_tenant_id is null or v_requested = 0 then
        return 0;
    end if;

    select count(*)::integer
      into v_owned
      from public.parsed_output
     where tenant_id = p_tenant_id
       and id = any(p_parsed_ids);

    if v_owned <> v_requested then
        raise exception 'parsed generation tenant/count mismatch: requested %, owned %',
            v_requested, v_owned;
    end if;

    -- These legacy foreign keys do not all use ON DELETE CASCADE.
    delete from public.resolver_decisions where parsed_id = any(p_parsed_ids);
    delete from public.enrichment_jobs where parsed_id = any(p_parsed_ids);
    delete from public.observation_evidence where parsed_id = any(p_parsed_ids);

    -- requirement_matches, listing_observations and broker_observations are
    -- removed by their parsed_output ON DELETE CASCADE foreign keys.
    delete from public.parsed_output
     where tenant_id = p_tenant_id
       and id = any(p_parsed_ids);

    get diagnostics v_owned = row_count;
    return v_owned;
end;
$$;

create or replace function public.replace_parsed_generation(
    p_tenant_id uuid,
    p_raw_message_id bigint,
    p_old_ids bigint[],
    p_new_ids bigint[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_old_count integer := coalesce(cardinality(p_old_ids), 0);
    v_new_count integer := coalesce(cardinality(p_new_ids), 0);
    v_verified integer;
    v_deleted integer := 0;
begin
    if p_tenant_id is null or p_raw_message_id is null or v_new_count < 2 then
        raise exception 'replacement requires tenant, raw message, and at least two new cards';
    end if;

    if p_old_ids && p_new_ids then
        raise exception 'old and new parsed generations overlap';
    end if;

    select count(*)::integer
      into v_verified
      from public.parsed_output
     where tenant_id = p_tenant_id
       and raw_message_id = p_raw_message_id
       and id = any(p_new_ids);

    if v_verified <> v_new_count then
        raise exception 'new parsed generation is incomplete: expected %, found %',
            v_new_count, v_verified;
    end if;

    if v_old_count > 0 then
        select count(*)::integer
          into v_verified
          from public.parsed_output
         where tenant_id = p_tenant_id
           and raw_message_id = p_raw_message_id
           and id = any(p_old_ids);

        if v_verified <> v_old_count then
            raise exception 'old parsed generation tenant/raw/count mismatch: expected %, found %',
                v_old_count, v_verified;
        end if;

        v_deleted := public.discard_parsed_generation(p_tenant_id, p_old_ids);
    end if;

    return jsonb_build_object(
        'raw_message_id', p_raw_message_id,
        'new_count', v_new_count,
        'old_deleted', v_deleted
    );
end;
$$;

revoke all on function public.discard_parsed_generation(uuid, bigint[])
    from public, anon, authenticated;
revoke all on function public.replace_parsed_generation(uuid, bigint, bigint[], bigint[])
    from public, anon, authenticated;

grant execute on function public.discard_parsed_generation(uuid, bigint[])
    to service_role;
grant execute on function public.replace_parsed_generation(uuid, bigint, bigint[], bigint[])
    to service_role;
