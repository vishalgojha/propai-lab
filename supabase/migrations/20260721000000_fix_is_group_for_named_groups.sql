-- Backfill is_group for messages with human-readable group names.
-- The original backfill only caught JIDs ending in @g.us, missing
-- groups stored by human-readable name (e.g. "Bandra Broker Group").

update raw_messages
set is_group = true
where is_group = false
  and group_name is not null
  and group_name != ''
  and group_name not like '%@g.us'
  and group_name not like '%@broadcast';
