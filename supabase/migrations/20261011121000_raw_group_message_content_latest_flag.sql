-- Global (cross-page) repost dedupe for the raw group-message archive.
--
-- The inbox pages raw group messages newest-first by a stable row offset and
-- used to collapse reposts in the application inside the fetched slab only, so
-- a repost that straddled a page boundary reappeared on the next page. Reposts
-- are also recorded as raw_messages.repeat_of_raw_message_id, but that chain is
-- only written once the extraction worker (which lags ingest) has processed the
-- row, so fresh pages showed duplicates.
--
-- A lag-independent fingerprint is computed from the message body at insert
-- time and an ``is_content_latest`` flag keeps only the newest occurrence per
-- (tenant_id, content_key). The feed filters ``is_content_latest = true``; the
-- per-row flag means deep offset pages read a partial index instead of
-- re-evaluating the fingerprint for every skipped row.

create or replace function public.raw_message_content_key(p_message text)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when length(btrim(regexp_replace(lower(coalesce(p_message, '')), '[[:space:]]+', ' ', 'g'))) >= 12
      then md5(btrim(regexp_replace(lower(coalesce(p_message, '')), '[[:space:]]+', ' ', 'g')))
    else null
  end;
$$;

comment on function public.raw_message_content_key(text) is
  'Whitespace/case-normalised content fingerprint of a raw WhatsApp message; null for short/empty noise. Lag-independent dedupe key for the raw inbox.';

alter table public.raw_messages
    add column if not exists content_key text;

alter table public.raw_messages
    add column if not exists is_content_latest boolean not null default true;

-- Replace the earlier slow read-side design if it was ever applied.
drop view if exists public.raw_group_messages_latest;
drop index if exists public.idx_raw_messages_content_latest;
drop index if exists public.idx_raw_messages_group_tenant_ts_id;

-- Sibling lookup for the trigger and the backfill: newest occurrence first.
create index if not exists idx_raw_messages_content_sibling
    on public.raw_messages (tenant_id, content_key, "timestamp" desc, id desc)
    where is_group
      and content_key is not null;

-- Backfill the fingerprint for existing rows.
update public.raw_messages
set content_key = public.raw_message_content_key(message)
where content_key is null;

-- Keep only the newest occurrence of each (tenant, content) as "latest".
update public.raw_messages r
set is_content_latest = false
from (
    select id,
           row_number() over (
               partition by tenant_id, content_key
               order by "timestamp" desc, id desc
           ) as rn
    from public.raw_messages
    where is_group
      and content_key is not null
) ranked
where r.id = ranked.id
  and ranked.rn > 1;

-- Feed read path: skip straight to the newest non-repost rows at any depth.
create index if not exists idx_raw_messages_content_latest_feed
    on public.raw_messages (tenant_id, "timestamp" desc, id desc)
    where is_group
      and is_content_latest;

-- Maintain the flag on insert. Runs after trg_raw_messages_tenant (alphabetical
-- order) so tenant_id is resolved first. In-order inserts (the common case)
-- find no newer sibling and simply demote any older copy. Out-of-order inserts
-- are flagged stale instead.
create or replace function public.set_raw_message_content_latest()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
declare
    k text;
begin
    if not coalesce(new.is_group, false) then
        new.is_content_latest := true;
        return new;
    end if;

    k := public.raw_message_content_key(new.message);
    new.content_key := k;

    if k is null then
        new.is_content_latest := true;
        return new;
    end if;

    if exists (
        select 1
        from public.raw_messages n
        where n.tenant_id = new.tenant_id
          and n.is_group
          and n.content_key = k
          and (n."timestamp", n.id) > (new."timestamp", new.id)
    ) then
        new.is_content_latest := false;
        return new;
    end if;

    new.is_content_latest := true;
    update public.raw_messages
    set is_content_latest = false
    where tenant_id = new.tenant_id
      and is_group
      and is_content_latest
      and content_key = k
      and ("timestamp", id) < (new."timestamp", new.id);

    return new;
end;
$$;

drop trigger if exists trg_raw_messages_tenant_content_latest on public.raw_messages;
create trigger trg_raw_messages_tenant_content_latest
before insert on public.raw_messages
for each row execute function public.set_raw_message_content_latest();

notify pgrst, 'reload schema';
