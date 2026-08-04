-- Preserve the original WhatsApp message as the parent and let the extractor
-- materialize deterministic child messages when a broadcast contains several
-- listings.  Existing rows remain valid because both columns are nullable.
alter table public.raw_messages
  add column if not exists parent_message_id bigint references public.raw_messages(id) on delete cascade;
alter table public.raw_messages
  add column if not exists split_index integer;

create index if not exists idx_raw_messages_parent_split
  on public.raw_messages(parent_message_id, split_index);

-- Backfill the identity that WhatsMeow already captured in raw_payload.  The
-- payload contains `214018304307415@lid`, while the map stores only the lid
-- number.  Work in batches so the 800k+ row repair does not create one long
-- transaction or hold a table-wide lock.
do $$
declare
  changed integer;
begin
  loop
    with candidates as (
      select rm.id,
             split_part(
               coalesce(
                 rm.raw_payload #>> '{data,key,participant}',
                 rm.raw_payload #>> '{key,participant}',
                 ''
               ), '@', 1
             ) as lid,
             coalesce(
               rm.raw_payload #>> '{data,key,participant}',
               rm.raw_payload #>> '{key,participant}'
             ) as participant,
             nullif(btrim(rm.raw_payload #>> '{data,pushName}'), '') as push_name,
             nullif(btrim(rm.raw_payload #>> '{data,sender,name}'), '') as sender_name
        from public.raw_messages rm
       where coalesce(btrim(rm.sender_phone), '') = ''
         and coalesce(
               rm.raw_payload #>> '{data,key,participant}',
               rm.raw_payload #>> '{key,participant}',
               ''
             ) like '%@lid'
         and exists (
               select 1
                 from public.whatsmeow_lid_map lm
                where lm.lid = split_part(
                  coalesce(
                    rm.raw_payload #>> '{data,key,participant}',
                    rm.raw_payload #>> '{key,participant}',
                    ''
                  ), '@', 1
                )
                  and coalesce(btrim(lm.pn), '') <> ''
             )
       order by rm.id
       limit 5000
    ), mapped as (
      select c.*, lm.pn
        from candidates c
        join public.whatsmeow_lid_map lm on lm.lid = c.lid
       where coalesce(btrim(lm.pn), '') <> ''
    )
    update public.raw_messages rm
       set sender_phone = case
             when mapped.pn like '%@%' then mapped.pn
             else mapped.pn || '@s.whatsapp.net'
           end,
           sender_jid = case
             when coalesce(btrim(rm.sender_jid), '') = '' then mapped.participant
             else rm.sender_jid
           end,
           sender = case
             when coalesce(btrim(rm.sender), '') = '' then coalesce(mapped.sender_name, mapped.push_name, '')
             else rm.sender
           end
      from mapped
     where rm.id = mapped.id;

    get diagnostics changed = row_count;
    exit when changed = 0;
  end loop;
end
$$;

create index if not exists idx_whatsmeow_lid_map_lid
  on public.whatsmeow_lid_map(lid);

create index if not exists idx_raw_messages_unmapped_lid
  on public.raw_messages (
    id,
    (split_part(
      coalesce(
        raw_payload #>> '{data,key,participant}',
        raw_payload #>> '{key,participant}',
        ''
      ), '@', 1
    ))
  )
  where coalesce(btrim(sender_phone), '') = ''
    and coalesce(
      raw_payload #>> '{data,key,participant}',
      raw_payload #>> '{key,participant}',
      ''
    ) like '%@lid';
