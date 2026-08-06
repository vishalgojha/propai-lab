-- Preserve the typed projection while restoring the named columns still used
-- by legacy API consumers.  The underlying typed view remains available as a
-- stable implementation detail; this wrapper is intentionally read-only.
begin;

alter view public.listings_unified rename to listings_unified_typed_projection;

create view public.listings_unified
with (security_invoker = true)
as
select
  l.*,
  l.source_fingerprint as fingerprint,
  coalesce(
    nullif(l.ai_extraction ->> 'developer', ''),
    nullif(l.ai_extraction ->> 'developer_name', '')
  ) as developer,
  l.property_view as orientation,
  nullif(l.raw_payload ->> 'pic_token', '') as pic_token,
  coalesce(
    nullif(l.raw_payload ->> 'listing_source', ''),
    (select rm.source from public.raw_messages rm where rm.id = l.raw_message_id),
    'WHATSAPP'
  ) as listing_source,
  l.location_label as location_raw
from public.listings_unified_typed_projection l;

grant select on public.listings_unified to anon, authenticated, service_role;
notify pgrst, 'reload schema';
commit;
