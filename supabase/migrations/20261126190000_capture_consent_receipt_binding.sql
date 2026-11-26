-- Bind capture consent to an explicit acknowledgement, not a clock cutoff.
--
-- The 9ddd0549 gate treated any receipt completed after the consent-wording
-- deploy as capture consent, but confirm_whatsapp_group_selection is also
-- reachable from older clients that never showed that wording, so a stale
-- bundle could mint capture consent without an informed Allow. This
-- migration records the acknowledged consent wording version on the
-- receipt itself: the API writes it only when the confirming client acks
-- the current wording, and the capture gate requires it.
--
-- Consent wording for version 'broker-group-capture-v1' (the "Allow saving
-- group messages" dialog whose Allow button submits the ack):
--   PropAI will save messages from the groups you confirm here, so you and
--   your assistant can search them. Messages from unchecked groups and
--   your personal chats are never saved. Sharing messages with other
--   brokers is a separate choice and stays off unless you allow it. You
--   can change your groups or turn saving off at any time.
--
-- A NULL capture_consent_version means the selection was confirmed without
-- the capture ack (older clients): it still governs extraction scope but
-- is not capture consent. The API revokes consent by blanking it together
-- with the state fingerprint; the receipt row stays as the audit record.
-- The new RPC parameter defaults to NULL so existing callers keep working
-- and simply record no capture consent.

begin;

set local lock_timeout='2s';
set local statement_timeout='15s';

alter table public.whatsapp_group_selection_receipts
 add column if not exists capture_consent_version text;

comment on column public.whatsapp_group_selection_receipts.capture_consent_version is
 'Capture-consent wording version acknowledged by the confirming client. NULL means the confirmation carried no capture acknowledgement and is not capture consent.';

drop function public.confirm_whatsapp_group_selection(uuid,bigint,text[],uuid,uuid,text);

create function public.confirm_whatsapp_group_selection(p_tenant uuid,p_connection bigint,p_groups text[],p_actor uuid,p_request uuid,p_broker text,p_capture_consent_version text default null)
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
  if receipt.organization_id is distinct from p_tenant or receipt.actor_id is distinct from p_actor or receipt.selected_group_jids is distinct from wanted or receipt.state_fingerprint is distinct from whatsapp_group_selection_fingerprint(p_tenant,p_connection) or receipt.capture_consent_version is distinct from p_capture_consent_version then raise exception 'Confirmation changed; review again'; end if;
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
 insert into whatsapp_group_selection_receipts(organization_id,whatsapp_connection_id,request_id,actor_id,selected_group_jids,state_fingerprint,completed_at,visibility_rows,capture_consent_version)
 values(p_tenant,p_connection,p_request,p_actor,wanted,whatsapp_group_selection_fingerprint(p_tenant,p_connection),now(),total,p_capture_consent_version)
 on conflict(whatsapp_connection_id) do update set organization_id=excluded.organization_id,request_id=excluded.request_id,actor_id=excluded.actor_id,selected_group_jids=excluded.selected_group_jids,state_fingerprint=excluded.state_fingerprint,completed_at=excluded.completed_at,visibility_rows=excluded.visibility_rows,capture_consent_version=excluded.capture_consent_version;
 return whatsapp_group_selection_state(p_tenant,p_connection);
end $$;


revoke all on function public.confirm_whatsapp_group_selection(uuid,bigint,text[],uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.confirm_whatsapp_group_selection(uuid,bigint,text[],uuid,uuid,text,text) to service_role;

create or replace function public.whatsapp_group_selection_state(p_tenant uuid,p_connection bigint)
returns jsonb language sql stable security definer set search_path=public,pg_temp as $$
 select coalesce((select jsonb_build_object('complete',r.state_fingerprint=whatsapp_group_selection_fingerprint(p_tenant,p_connection), 'request_id',r.request_id,'selected_group_jids',r.selected_group_jids,'completed_at',r.completed_at,'capture_consent_version',r.capture_consent_version)
 from whatsapp_group_selection_receipts r where r.organization_id=p_tenant and r.whatsapp_connection_id=p_connection),jsonb_build_object('complete',false,'selected_group_jids','[]'::jsonb))
$$;

notify pgrst,'reload schema';

commit;
