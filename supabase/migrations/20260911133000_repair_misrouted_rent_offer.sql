-- Repair one source-grounded rent offer that was persisted to the
-- requirements projection before the source-boundary route guard was active.
-- The raw WhatsApp message remains untouched; only its typed projection moves.
-- Idempotent: after the first run the source row no longer exists in the old
-- table, so rerunning this migration is a no-op.

do $$
declare
  common_columns text;
  set_columns text;
begin
  if exists (
    select 1
    from public.residential_rent_requirements
    where id = 4908
      and raw_message_id = 139791
      and source_fingerprint = '4e5d190ba67881ad02d5dcf8df9307b5c8ecd983a420c1ee39466ca058c8675b'
  ) then
    select string_agg(format('%I', target.column_name), ', ' order by target.ordinal_position)
      into common_columns
    from information_schema.columns target
    join information_schema.columns source
      on source.table_schema = target.table_schema
     and source.column_name = target.column_name
     and source.table_name = 'residential_rent_requirements'
    where target.table_schema = 'public'
      and target.table_name = 'residential_rent_listings'
      and target.column_name <> 'id';

    select string_agg(format('%1$I = excluded.%1$I', target.column_name), ', ' order by target.ordinal_position)
      into set_columns
    from information_schema.columns target
    join information_schema.columns source
      on source.table_schema = target.table_schema
     and source.column_name = target.column_name
     and source.table_name = 'residential_rent_requirements'
    where target.table_schema = 'public'
      and target.table_name = 'residential_rent_listings'
      and target.column_name not in ('id', 'source_fingerprint');

    execute format($sql$
      insert into public.residential_rent_listings (%1$s)
      select %1$s
      from public.residential_rent_requirements
      where id = 4908
        and raw_message_id = 139791
        and source_fingerprint = '4e5d190ba67881ad02d5dcf8df9307b5c8ecd983a420c1ee39466ca058c8675b'
      on conflict (source_fingerprint) do update set %2$s
    $sql$, common_columns, set_columns);

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
    where raw_message_id = 139791
      and source_fingerprint = '4e5d190ba67881ad02d5dcf8df9307b5c8ecd983a420c1ee39466ca058c8675b';

    delete from public.residential_rent_requirements
    where id = 4908
      and raw_message_id = 139791
      and source_fingerprint = '4e5d190ba67881ad02d5dcf8df9307b5c8ecd983a420c1ee39466ca058c8675b';
  end if;
end $$;
