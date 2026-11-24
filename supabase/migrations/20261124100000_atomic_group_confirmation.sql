-- Atomic group confirmation. Installation never replays existing selections.
begin;
set local lock_timeout='2s';
set local statement_timeout='15s';
create table public.whatsapp_group_selection_receipts (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 whatsapp_connection_id bigint primary key references public.org_whatsapp_connections(id) on delete cascade,
 request_id uuid not null,
 actor_id uuid not null references auth.users(id),
 selected_group_jids text[] not null,
 state_fingerprint text not null,
 completed_at timestamptz not null default now(),
 visibility_rows integer not null default 0
);
alter table public.whatsapp_group_selection_receipts enable row level security;
revoke all on public.whatsapp_group_selection_receipts from public,anon,authenticated;
grant select,insert,update,delete on public.whatsapp_group_selection_receipts to service_role;

create table public.whatsapp_group_selection_requests(request_id uuid primary key,whatsapp_connection_id bigint not null references public.org_whatsapp_connections(id) on delete cascade);
alter table public.whatsapp_group_selection_requests enable row level security;
revoke all on public.whatsapp_group_selection_requests from public,anon,authenticated;
grant select,insert on public.whatsapp_group_selection_requests to service_role;

create function public.invalidate_whatsapp_group_selection() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if TG_TABLE_NAME='org_whatsapp_connections' then
  if new.organization_id is distinct from old.organization_id or new.broker_id is distinct from old.broker_id or new.phone_number is distinct from old.phone_number or new.is_active is distinct from old.is_active then
   update whatsapp_group_selection_receipts set state_fingerprint='' where whatsapp_connection_id=old.id;
  end if;
 elsif TG_TABLE_NAME='organization_group_connections' then
  if TG_OP<>'INSERT' then update whatsapp_group_selection_receipts set state_fingerprint='' where whatsapp_connection_id=old.whatsapp_connection_id; end if;
  if TG_OP<>'DELETE' then update whatsapp_group_selection_receipts set state_fingerprint='' where whatsapp_connection_id=new.whatsapp_connection_id; end if;
 elsif TG_TABLE_NAME='broker_whatsapp_devices' then
  if TG_OP<>'INSERT' then update whatsapp_group_selection_receipts set state_fingerprint='' where whatsapp_connection_id in(select id from org_whatsapp_connections where broker_id=old.whatsapp_connection_key); end if;
  if TG_OP<>'DELETE' then update whatsapp_group_selection_receipts set state_fingerprint='' where whatsapp_connection_id in(select id from org_whatsapp_connections where broker_id=new.whatsapp_connection_key); end if;
 else
  if TG_OP<>'INSERT' then update whatsapp_group_selection_receipts set state_fingerprint='' where organization_id=old.tenant_id; end if;
  if TG_OP<>'DELETE' then update whatsapp_group_selection_receipts set state_fingerprint='' where organization_id=new.tenant_id; end if;
 end if;
 if TG_OP='DELETE' then return old; else return new; end if;
end $$;
create trigger invalidate_group_receipt_connection after update on org_whatsapp_connections for each row execute function invalidate_whatsapp_group_selection();
create trigger invalidate_group_receipt_groups after insert or update or delete on organization_group_connections for each row execute function invalidate_whatsapp_group_selection();
create trigger invalidate_group_receipt_device after insert or update or delete on broker_whatsapp_devices for each row execute function invalidate_whatsapp_group_selection();
create trigger invalidate_group_receipt_allowlist after insert or update or delete on public_market_publication_allowlist for each row execute function invalidate_whatsapp_group_selection();
revoke all on function public.invalidate_whatsapp_group_selection() from public,anon,authenticated;

create function public.whatsapp_group_selection_fingerprint(p_tenant uuid,p_connection bigint)
returns text language sql stable security definer set search_path=public,pg_temp as $$
 select md5(jsonb_build_array(
  (select jsonb_build_array(c.organization_id,c.broker_id,c.phone_number,c.is_active) from org_whatsapp_connections c where c.id=p_connection and c.organization_id=p_tenant),
  (select coalesce(jsonb_agg(to_jsonb(d) order by d.whatsapp_connection_key),'[]'::jsonb) from broker_whatsapp_devices d join org_whatsapp_connections c on c.broker_id=d.whatsapp_connection_key where c.id=p_connection and c.organization_id=p_tenant),
  (select coalesce(jsonb_agg(to_jsonb(a) order by a.whatsapp_connection_id),'[]'::jsonb) from public_market_publication_allowlist a where a.tenant_id=p_tenant),
  (select coalesce(jsonb_agg(jsonb_build_array(g.group_jid,g.is_active,g.opted_out,g.public_market_source,g.updated_at) order by g.group_jid),'[]'::jsonb) from organization_group_connections g where g.organization_id=p_tenant and g.whatsapp_connection_id=p_connection)
 )::text)
$$;
create function public.whatsapp_group_selection_state(p_tenant uuid,p_connection bigint)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce((select jsonb_build_object('complete',r.state_fingerprint=whatsapp_group_selection_fingerprint(p_tenant,p_connection), 'request_id',r.request_id,'selected_group_jids',r.selected_group_jids,'completed_at',r.completed_at)
 from whatsapp_group_selection_receipts r where r.organization_id=p_tenant and r.whatsapp_connection_id=p_connection),jsonb_build_object('complete',false,'selected_group_jids','[]'::jsonb))
$$;

create function public.confirm_whatsapp_group_selection(p_tenant uuid,p_connection bigint,p_groups text[],p_actor uuid,p_request uuid,p_broker text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.org_whatsapp_connections; wanted text[]; receipt public.whatsapp_group_selection_receipts;
 tab text; changed integer; total integer:=0; eligible boolean;
begin
 if p_request is null or p_actor is null or p_groups is null then raise exception 'Explicit confirmation identity is required'; end if;
 select * into c from org_whatsapp_connections where id=p_connection and organization_id=p_tenant for update;
 if not found or c.is_active is not true or coalesce(c.broker_id,'')='' or c.broker_id is distinct from p_broker then raise exception 'Connection changed; review again'; end if;
 if exists(select 1 from org_whatsapp_connections other where other.id<>p_connection and other.organization_id=p_tenant and other.broker_id=c.broker_id and other.is_active) then raise exception 'Ambiguous connection source; review required'; end if;
 if exists(select 1 from unnest(p_groups) g where g is null or g !~ '^[0-9-]+@g\.us$') then raise exception 'Invalid exact group identity'; end if;
 select coalesce(array_agg(distinct g order by g),'{}'::text[]) into wanted from unnest(p_groups) g;
 select * into receipt from whatsapp_group_selection_receipts where whatsapp_connection_id=p_connection;
 if found and receipt.request_id=p_request then
  if receipt.organization_id is distinct from p_tenant or receipt.actor_id is distinct from p_actor or receipt.selected_group_jids is distinct from wanted or receipt.state_fingerprint is distinct from whatsapp_group_selection_fingerprint(p_tenant,p_connection) then raise exception 'Confirmation changed; review again'; end if;
  return whatsapp_group_selection_state(p_tenant,p_connection);
 end if;
 if exists(select 1 from whatsapp_group_selection_requests where request_id=p_request) then raise exception 'Previous confirmation superseded; review again'; end if;
 if exists(select 1 from unnest(wanted) g where not exists(select 1 from whatsapp_conversations d where d.tenant_id=p_tenant and d.broker_id=c.broker_id and d.conversation_type='group' and d.conversation_jid=g)) then raise exception 'Group directory changed; review again'; end if;
 -- Retained rows never pass through an opted-out state. Existing privacy triggers remain active.
 update organization_group_connections set is_active=false,opted_out=true,public_market_source=false,updated_at=now()
 where organization_id=p_tenant and whatsapp_connection_id=p_connection and not(group_jid=any(wanted)) and (is_active or not opted_out or public_market_source);
 insert into organization_group_connections(organization_id,whatsapp_connection_id,group_jid,group_name,is_active,opted_out,public_market_source,network_owned,updated_at,connected_at)
 select p_tenant,p_connection,g,coalesce((select nullif(d.display_name,'') from whatsapp_conversations d where d.tenant_id=p_tenant and d.broker_id=c.broker_id and d.conversation_type='group' and d.conversation_jid=g order by d.display_name limit 1),g),true,false,true,false,now(),now() from unnest(wanted) g
 on conflict(organization_id,whatsapp_connection_id,group_jid) do update set group_name=excluded.group_name,is_active=true,opted_out=false,public_market_source=true,updated_at=now();
 -- Lock the eligibility row, if any. No allowlist row means no positive publication.
 perform 1 from public_market_publication_allowlist where tenant_id=p_tenant for share;
 select exists(select 1 from public_market_publication_allowlist where tenant_id=p_tenant and whatsapp_connection_id=p_connection and enabled) into eligible;
 foreach tab in array array['residential_sale_listings','residential_rent_listings','commercial_sale_listings','commercial_rent_listings','residential_sale_requirements','residential_rent_requirements','commercial_sale_requirements','commercial_rent_requirements'] loop
  execute format($sql$
   update public.%I t set visibility=case when $4 and (r.raw_payload #>> '{data,key,remoteJid}')=any($3) and not exists(select 1 from public_market_publication_denylist d where d.raw_message_id=r.id) then 'shared_market' else 'workspace_private' end,
    source_scope=case when $4 and (r.raw_payload #>> '{data,key,remoteJid}')=any($3) and not exists(select 1 from public_market_publication_denylist d where d.raw_message_id=r.id) then 'whatsapp_group_public' else 'whatsapp_private' end
   from raw_messages r where t.raw_message_id=r.id and t.tenant_id=$1 and r.tenant_id=$1 and r.is_group is true and r.source='WHATSAPP' and r.pipeline_version='go-ingestor'
    and r.raw_payload #>> '{data,broker_id}'=$2
    and r.raw_payload #>> '{data,key,remoteJid}' ~ '^[0-9-]+@g\.us$'
    and split_part(r.message_uid,':',1)=$2 and split_part(r.message_uid,':',2)=r.raw_payload #>> '{data,key,remoteJid}' and split_part(r.message_uid,':',3)<>''
    and r.event_id=$2||':'||split_part(r.message_uid,':',3)
    and r.message_uid=$2||':'||(r.raw_payload #>> '{data,key,remoteJid}')||':'||split_part(r.message_uid,':',3)
    and r.raw_payload #>> '{data,source}' is distinct from 'history_sync'
    and (t.visibility is distinct from case when $4 and (r.raw_payload #>> '{data,key,remoteJid}')=any($3) and not exists(select 1 from public_market_publication_denylist d where d.raw_message_id=r.id) then 'shared_market' else 'workspace_private' end
     or t.source_scope is distinct from case when $4 and (r.raw_payload #>> '{data,key,remoteJid}')=any($3) and not exists(select 1 from public_market_publication_denylist d where d.raw_message_id=r.id) then 'whatsapp_group_public' else 'whatsapp_private' end)
  $sql$,tab) using p_tenant,c.broker_id,wanted,eligible;
  get diagnostics changed=row_count;total:=total+changed;
 end loop;
 update org_whatsapp_connections set group_audit_required=false,group_audit_completed_at=now(),updated_at=now() where id=p_connection;
 insert into whatsapp_group_selection_requests values(p_request,p_connection);
 insert into whatsapp_group_selection_receipts values(p_tenant,p_connection,p_request,p_actor,wanted,whatsapp_group_selection_fingerprint(p_tenant,p_connection),now(),total)
 on conflict(whatsapp_connection_id) do update set organization_id=excluded.organization_id,request_id=excluded.request_id,actor_id=excluded.actor_id,selected_group_jids=excluded.selected_group_jids,state_fingerprint=excluded.state_fingerprint,completed_at=excluded.completed_at,visibility_rows=excluded.visibility_rows;
 return whatsapp_group_selection_state(p_tenant,p_connection);
end $$;
revoke all on function public.whatsapp_group_selection_fingerprint(uuid,bigint),public.whatsapp_group_selection_state(uuid,bigint),public.confirm_whatsapp_group_selection(uuid,bigint,text[],uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.whatsapp_group_selection_state(uuid,bigint),public.confirm_whatsapp_group_selection(uuid,bigint,text[],uuid,uuid,text) to service_role;
create function public.start_confirmed_whatsapp_extraction(p_tenant uuid,p_connection bigint)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
 perform 1 from org_whatsapp_connections where id=p_connection and organization_id=p_tenant and is_active for update;
 if not found or (whatsapp_group_selection_state(p_tenant,p_connection)->>'complete')::boolean is not true or not exists(select 1 from organization_group_connections where organization_id=p_tenant and whatsapp_connection_id=p_connection and is_active and not opted_out) then raise exception 'Current completed group confirmation is required'; end if;
 update org_whatsapp_connections set extraction_status='running',updated_at=now() where id=p_connection;
end $$;
revoke all on function public.start_confirmed_whatsapp_extraction(uuid,bigint) from public,anon,authenticated;
grant execute on function public.start_confirmed_whatsapp_extraction(uuid,bigint) to service_role;
notify pgrst,'reload schema';
commit;
