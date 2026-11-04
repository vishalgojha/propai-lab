-- Add semantic retrieval for live WhatsApp evidence without enqueueing any
-- existing raw_messages. History-sync and extraction-suppressed rows remain out.

alter table public.semantic_embeddings
  drop constraint if exists semantic_embeddings_entity_type_check;

alter table public.semantic_embeddings
  add constraint semantic_embeddings_entity_type_check
  check (entity_type in (
    'listing', 'requirement', 'building', 'building_alias',
    'locality', 'broker', 'broker_alias', 'raw_message'
  ));

create or replace function public.queue_semantic_embedding()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $function$
declare
  v_entity_type text;
  v_tenant_id uuid;
begin
  if tg_op = 'DELETE' then
    delete from public.semantic_embeddings
     where source_table = tg_table_name and source_id = old.id;
    delete from public.semantic_embedding_jobs
     where source_table = tg_table_name and source_id = old.id;
    return old;
  end if;

  if tg_table_name = 'raw_messages' and (
    coalesce(to_jsonb(new)->>'pipeline_version', '') = 'history-sync-suppressed'
    or coalesce((to_jsonb(new)->>'extraction_suppressed')::boolean, false)
  ) then
    return new;
  end if;

  v_entity_type := case
    when tg_table_name = 'raw_messages' then 'raw_message'
    when tg_table_name like '%_listings' then 'listing'
    when tg_table_name like '%_requirements' then 'requirement'
    when tg_table_name = 'buildings' then 'building'
    when tg_table_name = 'building_name_aliases' then 'building_alias'
    when tg_table_name = 'locality_reference' then 'locality'
    when tg_table_name = 'brokers' then 'broker'
    when tg_table_name = 'broker_aliases' then 'broker_alias'
    else null
  end;
  if v_entity_type is null then return new; end if;

  v_tenant_id := case
    when tg_table_name = 'locality_reference' then null
    else nullif(to_jsonb(new)->>'tenant_id', '')::uuid
  end;

  insert into public.semantic_embedding_jobs
    (tenant_id, entity_type, source_table, source_id, status, attempts,
     last_error, scheduled_after, started_at, completed_at, updated_at)
  values
    (v_tenant_id, v_entity_type, tg_table_name, new.id, 'pending', 0,
     null, now(), null, null, now())
  on conflict (source_table, source_id) do update set
    tenant_id = excluded.tenant_id,
    entity_type = excluded.entity_type,
    status = 'pending',
    attempts = 0,
    last_error = null,
    scheduled_after = now(),
    started_at = null,
    completed_at = null,
    updated_at = now();
  return new;
end;
$function$;

drop trigger if exists queue_semantic_embedding on public.raw_messages;
create trigger queue_semantic_embedding
  after insert or delete on public.raw_messages
  for each row execute function public.queue_semantic_embedding();

create or replace function public.get_raw_message_context(
  p_tenant_id uuid,
  p_raw_message_id bigint,
  p_before integer default 10,
  p_after integer default 10
)
returns table (
  id bigint,
  group_name text,
  sender text,
  message text,
  message_type text,
  "timestamp" timestamptz,
  source text,
  is_group boolean,
  chat_jid text,
  is_anchor boolean
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $function$
  with anchor as (
    select r.id, r.tenant_id, r.group_name, r.sender, r.message,
           r.message_type, r."timestamp", r.source, r.is_group,
           coalesce(
             nullif(r.raw_payload #>> '{data,key,remoteJid}', ''),
             nullif(r.raw_payload #>> '{key,remoteJid}', ''),
             nullif(split_part(coalesce(r.message_uid, ''), ':', 2), ''),
             case when r.group_name like '%@g.us' or r.group_name like '%@s.whatsapp.net'
                  then r.group_name end
           ) as chat_jid
      from public.raw_messages r
     where r.id = p_raw_message_id
       and r.tenant_id = p_tenant_id
  ),
  context_rows as (
    select r.id, r.group_name, r.sender, r.message, r.message_type,
           r."timestamp", r.source, r.is_group, a.chat_jid, false as is_anchor
      from public.raw_messages r
      join anchor a on a.tenant_id = r.tenant_id
     where a.chat_jid is not null
       and coalesce(
             nullif(r.raw_payload #>> '{data,key,remoteJid}', ''),
             nullif(r.raw_payload #>> '{key,remoteJid}', ''),
             nullif(split_part(coalesce(r.message_uid, ''), ':', 2), ''),
             case when r.group_name like '%@g.us' or r.group_name like '%@s.whatsapp.net'
                  then r.group_name end
           ) = a.chat_jid
       and (r."timestamp", r.id) < (a."timestamp", a.id)
     order by r."timestamp" desc, r.id desc
     limit greatest(0, least(coalesce(p_before, 10), 50))
  ),
  anchor_row as (
    select a.id, a.group_name, a.sender, a.message, a.message_type,
           a."timestamp", a.source, a.is_group, a.chat_jid, true as is_anchor
      from anchor a
  ),
  after_rows as (
    select r.id, r.group_name, r.sender, r.message, r.message_type,
           r."timestamp", r.source, r.is_group, a.chat_jid, false as is_anchor
      from public.raw_messages r
      join anchor a on a.tenant_id = r.tenant_id
     where a.chat_jid is not null
       and coalesce(
             nullif(r.raw_payload #>> '{data,key,remoteJid}', ''),
             nullif(r.raw_payload #>> '{key,remoteJid}', ''),
             nullif(split_part(coalesce(r.message_uid, ''), ':', 2), ''),
             case when r.group_name like '%@g.us' or r.group_name like '%@s.whatsapp.net'
                  then r.group_name end
           ) = a.chat_jid
       and (r."timestamp", r.id) > (a."timestamp", a.id)
     order by r."timestamp", r.id
     limit greatest(0, least(coalesce(p_after, 10), 50))
  )
  select * from (
    select * from context_rows
    union all
    select * from anchor_row
    union all
    select * from after_rows
  ) context_messages
  order by "timestamp", id
$function$;

revoke all on function public.get_raw_message_context(uuid, bigint, integer, integer)
  from public, anon, authenticated;
grant execute on function public.get_raw_message_context(uuid, bigint, integer, integer)
  to service_role;
