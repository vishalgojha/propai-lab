-- No-LLM quarantine for the confirmed historical grounding blast radius.
-- This preserves every source row and only removes affected opportunities from
-- clean feeds by setting review/duplicate flags. The predicate mirrors Finding
-- 7: effective confidence < 20% plus at least one populated non-provenance
-- typed field with zero compact-token overlap against its source evidence.

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'residential_sale_listings',
    'residential_rent_listings',
    'commercial_sale_listings',
    'commercial_rent_listings',
    'residential_sale_requirements',
    'residential_rent_requirements',
    'commercial_sale_requirements',
    'commercial_rent_requirements'
  ] loop
    execute format($sql$
      with candidates as (
        select t.id,
               t.validation_flags,
               to_jsonb(t) as row_data,
               lower(coalesce(
                 nullif(t.raw_payload->>'slice_text', ''),
                 nullif(t.normalized_message, ''),
                 r.message,
                 ''
               )) as source_text
        from public.%1$I t
        left join public.raw_messages r on r.id = t.raw_message_id
        where coalesce(
          nullif((t.ai_extraction->>'extraction_confidence_score')::text, '')::numeric,
          case lower(t.extraction_confidence)
            when 'high' then .9
            when 'medium' then .6
            when 'low' then .1
            else 0
          end
        ) < .2
      ), affected as (
        select distinct c.id
        from candidates c
        cross join lateral jsonb_each_text(c.row_data) e
        where e.key not in (
          'id', 'raw_message_id', 'tenant_id', 'listing_index',
          'source_fingerprint', 'legacy_source_id', 'created_at',
          'updated_at', 'last_seen_at', 'expires_at', 'raw_payload',
          'ai_extraction', 'normalized_message', 'validation_flags',
          'needs_review', 'extraction_confidence', 'corrected_fields',
          'correction_confidence', 'corrected_at'
        )
        and e.value not in ('null', '', '[]', '{}')
        and regexp_replace(lower(e.value), '[^a-z0-9]+', '', 'g') <> ''
        and position(
          regexp_replace(lower(e.value), '[^a-z0-9]+', '', 'g') in
          regexp_replace(lower(c.source_text), '[^a-z0-9]+', '', 'g')
        ) = 0
        and not (e.key like '%%price%%' and e.value ~ '[0-9]')
      )
      update public.%1$I t
      set duplicate_status = 'flagged',
          needs_review = true,
          validation_flags = (
            select jsonb_agg(flag order by flag)
            from (
              select value as flag
              from jsonb_array_elements_text(
                case
                  when jsonb_typeof(coalesce(t.validation_flags, '[]'::jsonb)) = 'array'
                    then coalesce(t.validation_flags, '[]'::jsonb)
                  else '[]'::jsonb
                end
              )
              union
              select 'grounding_backfill_20260830'::text
            ) flags
          )
      from affected a
      where t.id = a.id
    $sql$, table_name);
  end loop;
end $$;
