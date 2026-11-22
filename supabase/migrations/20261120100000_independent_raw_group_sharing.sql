-- Independent raw-message sharing. No legacy selections or consents are promoted.
-- Flags must remain OFF until reviewed application/UI and migration are accepted.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '10s';
create table public.broker_market_raw_source_consents (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 whatsapp_connection_id bigint not null references public.org_whatsapp_connections(id) on delete cascade,
 broker_id text not null,
 group_jid text not null check (group_jid ~ '^[0-9-]+@g\.us$'),
 group_name text not null,
 version text not null check (version = 'broker-property-cross-search-v2'),
 confirmed_by uuid not null references auth.users(id),
 confirmed_at timestamptz not null default now(),
 revoked_at timestamptz,
 primary key (organization_id,whatsapp_connection_id,group_jid)
);
alter table public.broker_market_raw_source_consents enable row level security;
revoke all on public.broker_market_raw_source_consents from public,anon,authenticated;
grant select,insert,update,delete on public.broker_market_raw_source_consents to service_role;

-- Serialized with connection identity changes. Validation precedes every write.
create function public.broker_market_set_raw_sources(
 p_tenant uuid,p_connection bigint,p_groups text[],p_actor uuid,p_version text,p_enabled boolean
) returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.org_whatsapp_connections; wanted text[]; changed integer;
begin
 if p_version is distinct from 'broker-property-cross-search-v2' or p_enabled is null then
  raise exception 'Current raw sharing confirmation is required';
 end if;
 select * into c from public.org_whatsapp_connections
 where id=p_connection and organization_id=p_tenant for update;
 if not found or c.is_active is not true or coalesce(c.broker_id,'')='' then
  raise exception 'Active workspace connection not found';
 end if;
 if p_groups is null or cardinality(p_groups) not between 1 and 200
 or exists(select 1 from unnest(p_groups) g where g is null or g !~ '^[0-9-]+@g\.us$') then
  raise exception 'Choose between 1 and 200 exact groups';
 end if;
 select array_agg(distinct g order by g) into wanted from unnest(p_groups) g;
 -- The connection lock serializes the negative-control/device triggers below.
 -- Do not lock their rows here: their writers already hold those row locks.
 if p_enabled then
  if exists(select 1 from public.organization_group_connections where organization_id=p_tenant
   and whatsapp_connection_id=p_connection and group_jid=any(wanted) and opted_out is true)
  then raise exception 'Group is opted out; restore privacy control before selecting raw sharing'; end if;
  if exists(select 1 from unnest(wanted) g where not exists(
   select 1 from public.whatsapp_conversations d where d.tenant_id=p_tenant
    and d.broker_id=c.broker_id and d.conversation_type='group' and d.conversation_jid=g
  )) then raise exception 'Group directory changed; review exact groups again'; end if;
  insert into public.broker_market_raw_source_consents as old
   (organization_id,whatsapp_connection_id,broker_id,group_jid,group_name,version,confirmed_by,confirmed_at,revoked_at)
  select p_tenant,p_connection,c.broker_id,g,
   coalesce((select nullif(d.display_name,'') from public.whatsapp_conversations d
    where d.tenant_id=p_tenant and d.broker_id=c.broker_id and d.conversation_type='group'
     and d.conversation_jid=g order by d.display_name limit 1),g),p_version,p_actor,now(),null
  from unnest(wanted) g
  on conflict (organization_id,whatsapp_connection_id,group_jid) do update set
   broker_id=excluded.broker_id,group_name=excluded.group_name,version=excluded.version,
   confirmed_by=case when old.revoked_at is null and old.broker_id=excluded.broker_id then old.confirmed_by else excluded.confirmed_by end,
   confirmed_at=case when old.revoked_at is null and old.broker_id=excluded.broker_id then old.confirmed_at else excluded.confirmed_at end,
   revoked_at=null;
  get diagnostics changed=row_count;
 else
  update public.broker_market_raw_source_consents set revoked_at=now()
   where organization_id=p_tenant and whatsapp_connection_id=p_connection
    and group_jid=any(wanted) and revoked_at is null;
  get diagnostics changed=row_count;
 end if;
 return changed;
end $$;
revoke all on function public.broker_market_set_raw_sources(uuid,bigint,text[],uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.broker_market_set_raw_sources(uuid,bigint,text[],uuid,text,boolean) to service_role;

-- Only presentation punctuation is ignored. Country/trunk digits are NOT guessed.
-- Invalid/unpaired values remain distinct from a real authenticated phone.
create function public.broker_market_phone_identity(value text) returns text
language sql immutable set search_path=public,pg_temp as $$
 select case when btrim(value) ~ '^[+0-9() .-]+$'
  and length(regexp_replace(value,'[^0-9]','','g')) between 10 and 15
 then regexp_replace(value,'[^0-9]','','g') else value end
$$;
revoke all on function public.broker_market_phone_identity(text) from public,anon,authenticated;

create function public.broker_market_revoke_raw_connection() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.organization_id is distinct from old.organization_id
 or new.broker_id is distinct from old.broker_id
 or public.broker_market_phone_identity(new.phone_number) is distinct from public.broker_market_phone_identity(old.phone_number)
 or new.is_active is not true then
  update public.broker_market_raw_source_consents set revoked_at=now()
   where whatsapp_connection_id=old.id and revoked_at is null;
 end if;
 return new;
end $$;
create trigger broker_market_revoke_raw_connection before update on public.org_whatsapp_connections
for each row execute function public.broker_market_revoke_raw_connection();
revoke all on function public.broker_market_revoke_raw_connection() from public,anon,authenticated;

-- Negative group controls revoke; positive extraction selection never grants/restores raw.
create function public.broker_market_revoke_raw_group() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare prior public.organization_group_connections; candidate public.organization_group_connections;
begin
 if TG_OP<>'INSERT' then prior:=old; end if;
 if TG_OP<>'DELETE' then candidate:=new; end if;
 if TG_OP='DELETE' or (TG_OP='UPDATE' and
   (new.organization_id is distinct from old.organization_id or new.whatsapp_connection_id is distinct from old.whatsapp_connection_id
    or new.group_jid is distinct from old.group_jid)) then
  perform 1 from public.org_whatsapp_connections where id=prior.whatsapp_connection_id for update;
  update public.broker_market_raw_source_consents set revoked_at=clock_timestamp()
   where organization_id=prior.organization_id and whatsapp_connection_id=prior.whatsapp_connection_id
    and group_jid=prior.group_jid and revoked_at is null;
 end if;
 if TG_OP<>'DELETE' and (candidate.opted_out is true or candidate.is_active is not true) then
  perform 1 from public.org_whatsapp_connections where id=candidate.whatsapp_connection_id for update;
  update public.broker_market_raw_source_consents set revoked_at=clock_timestamp()
   where organization_id=candidate.organization_id and whatsapp_connection_id=candidate.whatsapp_connection_id
    and group_jid=candidate.group_jid and revoked_at is null;
 end if;
 if TG_OP='DELETE' then return old; else return new; end if;
end $$;
create trigger broker_market_revoke_raw_group after insert or update or delete on public.organization_group_connections
for each row execute function public.broker_market_revoke_raw_group();
revoke all on function public.broker_market_revoke_raw_group() from public,anon,authenticated;

-- A device-map replacement/deletion is an identity boundary even with same broker key.
create function public.broker_market_revoke_raw_device() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare keys text[];
begin
 if TG_OP='UPDATE' and new.whatsapp_connection_key is not distinct from old.whatsapp_connection_key
  and new.device_jid is not distinct from old.device_jid then return new; end if;
 if TG_OP='INSERT' then keys:=array[new.whatsapp_connection_key];
 elsif TG_OP='DELETE' then keys:=array[old.whatsapp_connection_key];
 else keys:=array[old.whatsapp_connection_key,new.whatsapp_connection_key]; end if;
 perform 1 from public.org_whatsapp_connections where broker_id=any(keys) order by id for update;
 update public.broker_market_raw_source_consents set revoked_at=clock_timestamp()
  where broker_id=any(keys) and revoked_at is null;
 if TG_OP='DELETE' then return old; else return new; end if;
end $$;
create trigger broker_market_revoke_raw_device after insert or update or delete on public.broker_whatsapp_devices
for each row execute function public.broker_market_revoke_raw_device();
revoke all on function public.broker_market_revoke_raw_device() from public,anon,authenticated;

create or replace view public.broker_market_eligible_source_rows as
 select r.id as raw_id,r.message as body,r.timestamp as posted_at,r.sender_phone,r.sender_jid
 from public.raw_messages r
 join public.org_whatsapp_connections c on c.organization_id=r.tenant_id
  and c.broker_id=split_part(r.event_id,':',1) and c.is_active is true
 join public.broker_market_raw_source_consents consent on consent.organization_id=r.tenant_id
  and consent.whatsapp_connection_id=c.id and consent.broker_id=c.broker_id
  and consent.group_jid=r.raw_payload #>> '{data,key,remoteJid}'
 where r.is_group is true and r.source='WHATSAPP' and r.pipeline_version='go-ingestor'
  and r.raw_payload #>> '{data,source}' is distinct from 'history_sync'
  and consent.group_jid ~ '^[0-9-]+@g\.us$'
  and split_part(r.message_uid,':',1)=c.broker_id
  and split_part(r.message_uid,':',2)=consent.group_jid
  and split_part(r.message_uid,':',3)<>''
  and r.event_id=c.broker_id||':'||split_part(r.message_uid,':',3)
  and r.message_uid=c.broker_id||':'||consent.group_jid||':'||split_part(r.message_uid,':',3)
  and not exists(select 1 from public.organization_group_connections privacy
   where privacy.organization_id=c.organization_id and privacy.whatsapp_connection_id=c.id
    and privacy.group_jid=consent.group_jid and privacy.opted_out is true)
  and consent.version='broker-property-cross-search-v2' and consent.revoked_at is null
  and r.synced_at>=consent.confirmed_at and r.timestamp>=consent.confirmed_at;
-- Existing search/get functions use this same view. ACLs are preserved by REPLACE.
commit;
