-- Keep the admin dedupe evidence endpoint off the full raw_messages scan.
-- The gate only exposes rows that point to an earlier raw observation.

create index if not exists raw_messages_repeat_observation_feed_idx
    on public.raw_messages (timestamp desc, id desc)
    where repeat_of_raw_message_id is not null;

create index if not exists raw_messages_repeat_observation_count_idx
    on public.raw_messages (id)
    where repeat_of_raw_message_id is not null;

create index if not exists raw_messages_repeat_observation_decision_idx
    on public.raw_messages (extraction_outcome, timestamp desc, id desc)
    where repeat_of_raw_message_id is not null;
