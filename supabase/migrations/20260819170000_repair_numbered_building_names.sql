-- A numbered WhatsApp item often ends with its building name:
--   (3)
--   Sunny Side
-- Repair the known persisted case where the preceding amenity line became
-- the building name. The extractor now applies the same source-bound rule to
-- future rows.
with marker_names as (
  select
    id as raw_message_id,
    trim((regexp_match(
      message,
      E'\\(\\s*[0-9]+\\s*\\)\\s*\\n\\s*([^\\n]+)'
    ))[1]) as building_name
  from public.raw_messages
  where message ~ E'\\(\\s*[0-9]+\\s*\\)\\s*\\n'
)
update public.residential_rent_listings listing
set building_name = marker_names.building_name,
    updated_at = now()
from marker_names
where listing.raw_message_id = marker_names.raw_message_id
  and listing.building_name ilike '%amenities%'
  and marker_names.building_name !~* E'(^[0-9]|rent|sale|bhk|sq\\.?[[:space:]]*ft|furnished|parking|contact|phone|call|whatsapp|available|amenities)';
