-- Move the verified inventory offer from the requirements projection.
-- Raw WhatsApp evidence is retained; this is an idempotent typed-route repair.

do $$
declare
  columns text;
begin
  if exists (
    select 1 from public.residential_rent_requirements
    where id = 4820 and raw_message_id = 807209
      and source_fingerprint = 'e19d0642ea48f0f8b819635c30a9868cb647c5efcc6001468599dec1ae2dbb0f'
  ) then
    -- The raw event is authoritative for tenant ownership. This legacy row
    -- carries a stale tenant id, which the typed-table trigger must reject.
    update public.residential_rent_requirements r
    set tenant_id = m.tenant_id
    from public.raw_messages m
    where r.id = 4820 and r.raw_message_id = 807209
      and m.id = r.raw_message_id;

    select string_agg(format('%I', target.column_name), ', ' order by target.ordinal_position)
      into columns
    from information_schema.columns target
    join information_schema.columns source
      on source.table_schema = target.table_schema
     and source.table_name = 'residential_rent_requirements'
     and source.column_name = target.column_name
    where target.table_schema = 'public'
      and target.table_name = 'residential_rent_listings'
      and target.column_name <> 'id';

    execute format($sql$
      insert into public.residential_rent_listings (%1$s)
      select %1$s from public.residential_rent_requirements
      where id = 4820 and raw_message_id = 807209
        and source_fingerprint = 'e19d0642ea48f0f8b819635c30a9868cb647c5efcc6001468599dec1ae2dbb0f'
      on conflict (source_fingerprint) do nothing
    $sql$, columns);

    update public.residential_rent_listings
    set ai_extraction = jsonb_set(
          jsonb_set(coalesce(ai_extraction, '{}'::jsonb), '{listing_type}', '"rent"'::jsonb),
          '{message_class}', '"listing"'::jsonb
        ),
        validation_flags = (
          select jsonb_agg(to_jsonb(value) order by value)
          from (
            select distinct value
            from jsonb_array_elements_text(
              coalesce(validation_flags, '[]'::jsonb)
              || '["route_repaired_from_requirement"]'::jsonb
            ) as element(value)
          ) values_set
        ),
        needs_review = true,
        updated_at = now()
    where raw_message_id = 807209
      and source_fingerprint = 'e19d0642ea48f0f8b819635c30a9868cb647c5efcc6001468599dec1ae2dbb0f';

    delete from public.residential_rent_requirements
    where id = 4820 and raw_message_id = 807209
      and source_fingerprint = 'e19d0642ea48f0f8b819635c30a9868cb647c5efcc6001468599dec1ae2dbb0f';
  end if;
end $$;
