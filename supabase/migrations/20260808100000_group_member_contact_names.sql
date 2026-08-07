-- Keep group_members.display_name populated from WhatsMeow's contact store.
-- Group snapshots often contain a participant JID but no DisplayName.

create or replace function public.normalize_whatsapp_phone_key(value text)
returns text
language sql
immutable
as $$
  with digits as (
    select regexp_replace(
      split_part(coalesce(value, ''), '@', 1), '[^0-9]', '', 'g'
    ) as value
  )
  select case
    when length(value) = 12 and left(value, 2) = '91' then right(value, 10)
    when length(value) = 11 and left(value, 1) = '0' then right(value, 10)
    else value
  end
  from digits;
$$;

create index if not exists idx_whatsmeow_contacts_their_jid_lower
  on public.whatsmeow_contacts (lower(trim(their_jid)));

create index if not exists idx_whatsmeow_contacts_phone_key
  on public.whatsmeow_contacts
  (public.normalize_whatsapp_phone_key(their_jid));

create or replace function public.enrich_group_member_display_name()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  contact_name text;
  member_key text;
begin
  -- Never replace a known name with an empty incoming snapshot value.
  if nullif(btrim(new.display_name), '') is not null then
    return new;
  end if;

  if tg_op = 'UPDATE' and nullif(btrim(old.display_name), '') is not null then
    new.display_name := old.display_name;
    return new;
  end if;

  member_key := public.normalize_whatsapp_phone_key(
    coalesce(nullif(btrim(new.member_phone), ''), new.member_jid)
  );

  -- Prefer an exact JID match. This handles both phone JIDs and LIDs.
  select coalesce(
           nullif(btrim(c.full_name), ''),
           nullif(btrim(c.push_name), ''),
           nullif(btrim(c.business_name), '')
         )
    into contact_name
    from public.whatsmeow_contacts c
   where lower(trim(c.their_jid)) = lower(trim(new.member_jid))
     and coalesce(nullif(btrim(c.full_name), ''),
                  nullif(btrim(c.push_name), ''),
                  nullif(btrim(c.business_name), '')) is not null
   limit 1;

  -- Then match the normalized phone/JID key. This handles phone-vs-LID
  -- representations and country-code/leading-zero differences.
  if contact_name is null and member_key <> '' then
    select coalesce(
             nullif(btrim(c.full_name), ''),
             nullif(btrim(c.push_name), ''),
             nullif(btrim(c.business_name), '')
           )
      into contact_name
      from public.whatsmeow_contacts c
     where public.normalize_whatsapp_phone_key(c.their_jid) = member_key
       and coalesce(nullif(btrim(c.full_name), ''),
                    nullif(btrim(c.push_name), ''),
                    nullif(btrim(c.business_name), '')) is not null
     limit 1;
  end if;

  new.display_name := contact_name;
  return new;
end;
$$;

drop trigger if exists trg_enrich_group_member_display_name
  on public.group_members;

create trigger trg_enrich_group_member_display_name
before insert or update of member_jid, member_phone, display_name
on public.group_members
for each row
execute function public.enrich_group_member_display_name();

-- One-time repair for historical rows. Only blank names are touched; existing
-- names are preserved. The ordering matches the trigger: exact JID first,
-- then normalized phone/JID, with full_name preferred over push_name and
-- business_name.
with candidates as (
  select gm.id,
         coalesce(exact_name.name, phone_name.name) as contact_name
    from public.group_members gm
    left join lateral (
      select coalesce(nullif(btrim(c.full_name), ''),
                      nullif(btrim(c.push_name), ''),
                      nullif(btrim(c.business_name), '')) as name
        from public.whatsmeow_contacts c
       where lower(trim(c.their_jid)) = lower(trim(gm.member_jid))
         and coalesce(nullif(btrim(c.full_name), ''),
                      nullif(btrim(c.push_name), ''),
                      nullif(btrim(c.business_name), '')) is not null
       limit 1
    ) exact_name on true
    left join lateral (
      select coalesce(nullif(btrim(c.full_name), ''),
                      nullif(btrim(c.push_name), ''),
                      nullif(btrim(c.business_name), '')) as name
        from public.whatsmeow_contacts c
       where public.normalize_whatsapp_phone_key(c.their_jid) =
             public.normalize_whatsapp_phone_key(
               coalesce(nullif(btrim(gm.member_phone), ''), gm.member_jid)
             )
         and coalesce(nullif(btrim(c.full_name), ''),
                      nullif(btrim(c.push_name), ''),
                      nullif(btrim(c.business_name), '')) is not null
       limit 1
    ) phone_name on true
   where nullif(btrim(gm.display_name), '') is null
)
update public.group_members gm
   set display_name = candidates.contact_name
  from candidates
 where gm.id = candidates.id
   and candidates.contact_name is not null;

create table if not exists public.data_quality_backfill_runs (
  id bigint generated always as identity primary key,
  run_name text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);

insert into public.data_quality_backfill_runs(run_name, details)
select 'group_member_contact_names', jsonb_build_object(
  'matched_rows', count(*) filter (where nullif(btrim(display_name), '') is not null),
  'remaining_blank_rows', count(*) filter (where nullif(btrim(display_name), '') is null),
  'total_rows', count(*)
)
from public.group_members;
