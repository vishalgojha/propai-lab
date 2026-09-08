-- Expand the global Gurukrupa extraction block from name-only matching to all
-- sender phone identities observed on Gurukrupa-tagged source messages.
-- Raw evidence is retained; queued rows are marked suppressed before parsing.

with gurukrupa_phones as (
  select distinct regexp_replace(sender_phone, '\\D', '', 'g') as phone
  from public.raw_messages
  where coalesce(sender_phone, '') <> ''
    and (
      lower(coalesce(message, '')) like '%gurukrupa%'
      or lower(coalesce(message, '')) like '%gurukirpa%'
      or lower(coalesce(sender, '')) like '%gurukrupa%'
      or lower(coalesce(sender, '')) like '%gurukirpa%'
      or lower(coalesce(raw_payload #>> '{data,pushName}', '')) like '%gurukrupa%'
      or lower(coalesce(raw_payload #>> '{data,pushName}', '')) like '%gurukirpa%'
    )
    and regexp_replace(sender_phone, '\\D', '', 'g') <> ''
), merged_aliases as (
  select coalesce(
    jsonb_agg(distinct to_jsonb(value) order by to_jsonb(value)),
    '[]'::jsonb
  ) as aliases
  from (
    select jsonb_array_elements_text(coalesce(b.aliases, '[]'::jsonb)) as value
    from public.system_extraction_source_blocks b
    where b.source_key = 'gurukrupa'
    union
    select phone from gurukrupa_phones
  ) values_to_keep
)
update public.system_extraction_source_blocks b
set aliases = merged_aliases.aliases,
    active = true,
    updated_at = now()
from merged_aliases
where b.source_key = 'gurukrupa';

update public.raw_messages rm
set processed = true,
    processed_at = coalesce(rm.processed_at, now()),
    extraction_suppressed = true,
    extraction_outcome = 'system_blocked:Gurukrupa',
    extraction_last_error = 'Source blocked by system policy before extraction'
where coalesce(rm.processed, false) = false
  and (
    lower(coalesce(rm.message, '')) like '%gurukrupa%'
    or lower(coalesce(rm.message, '')) like '%gurukirpa%'
    or lower(coalesce(rm.sender, '')) like '%gurukrupa%'
    or lower(coalesce(rm.sender, '')) like '%gurukirpa%'
    or lower(coalesce(rm.raw_payload #>> '{data,pushName}', '')) like '%gurukrupa%'
    or lower(coalesce(rm.raw_payload #>> '{data,pushName}', '')) like '%gurukirpa%'
    or regexp_replace(coalesce(rm.sender_phone, ''), '\\D', '', 'g') in (
      select jsonb_array_elements_text(b.aliases)
      from public.system_extraction_source_blocks b
      where b.source_key = 'gurukrupa' and b.active
    )
  );
