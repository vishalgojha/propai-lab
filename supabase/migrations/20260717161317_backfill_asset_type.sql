-- Backfill residential/commercial classification for historical rows.
-- The asset_type/property_type columns only existed in code (PARSED_OUTPUT_COLUMNS)
-- but were never created in the DB, so nothing was ever persisted. This derives
-- them from the original raw message text and cascades to parsed_output -> listings.
-- Idempotent: only fills NULL values.

-- 1) Classify parsed_output rows that are missing asset_type, using the linked
--    raw message text (mirrors app.py:_infer_asset_and_property_type).
update parsed_output p
set
  asset_type = case
    when lower(coalesce(r.message, '')) ~ '\y(commercial|office|shop|showroom|warehouse|godown|retail|co[- ]?working|coworking|industrial|factory|plot|land)\y'
      then 'commercial'
    else 'residential'
  end,
  property_type = case
    when lower(coalesce(r.message, '')) ~ '\y(office|workstation|cabin)\y' then 'office'
    when lower(coalesce(r.message, '')) ~ '\y(showroom)\y' then 'showroom'
    when lower(coalesce(r.message, '')) ~ '\y(shop|retail)\y' then 'shop'
    when lower(coalesce(r.message, '')) ~ '\y(warehouse|godown)\y' then 'warehouse'
    when lower(coalesce(r.message, '')) ~ '\y(industrial|factory|manufacturing)\y' then 'industrial'
    when lower(coalesce(r.message, '')) ~ '\y(plot|land)\y' then 'plot'
    when lower(coalesce(r.message, '')) ~ '\y(commercial)\y' then 'other'
    else null
  end
from raw_messages r
where p.raw_message_id = r.id
  and p.asset_type is null;

-- 2) Cascade to listings via representative_raw_message_id -> parsed_output.
update listings l
set
  asset_type = p.asset_type,
  property_type = p.property_type
from parsed_output p
where l.representative_raw_message_id = p.raw_message_id
  and l.asset_type is null
  and p.asset_type is not null;

-- 3) Any remaining listings whose representative parsed row had no match: derive
--    directly from the linked raw message text as a fallback.
update listings l
set
  asset_type = case
    when lower(coalesce(r.message, '')) ~ '\y(commercial|office|shop|showroom|warehouse|godown|retail|co[- ]?working|coworking|industrial|factory|plot|land)\y'
      then 'commercial'
    else 'residential'
  end,
  property_type = case
    when lower(coalesce(r.message, '')) ~ '\y(office|workstation|cabin)\y' then 'office'
    when lower(coalesce(r.message, '')) ~ '\y(showroom)\y' then 'showroom'
    when lower(coalesce(r.message, '')) ~ '\y(shop|retail)\y' then 'shop'
    when lower(coalesce(r.message, '')) ~ '\y(warehouse|godown)\y' then 'warehouse'
    when lower(coalesce(r.message, '')) ~ '\y(industrial|factory|manufacturing)\y' then 'industrial'
    when lower(coalesce(r.message, '')) ~ '\y(plot|land)\y' then 'plot'
    when lower(coalesce(r.message, '')) ~ '\y(commercial)\y' then 'other'
    else null
  end
from raw_messages r
where l.representative_raw_message_id = r.id
  and l.asset_type is null;
