-- Opt-in capture of property-listing messages that broker contacts send as
-- direct messages (WhatsApp broadcast lists arrive as ordinary DMs).
--
-- Scope, per the approved design:
--   * Capture starts only for senders the workspace owner explicitly selects
--     one by one, and only when the current consent wording was confirmed.
--   * A second, content-side gate keeps only messages that look like property
--     listings; personal chatter from the same sender is not persisted.
--   * Captured DM rows are searchable only inside the owner's own account.
--     They are is_group=false and carry no group consent row, so they can
--     never enter broker_market_eligible_source_rows or any cross-broker
--     surface. They are also extraction-suppressed at ingestion.
--   * Everything fails closed: any lookup error or wording-version mismatch
--     means the message is dropped before it is stored.
--
-- This consent is separate from group capture consent
-- (whatsapp_group_selection_receipts) and from raw cross-broker sharing
-- (broker_market_raw_source_consents). It widens neither.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '10s';

create table public.broker_dm_capture_senders (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 whatsapp_connection_id bigint not null references public.org_whatsapp_connections(id) on delete cascade,
 broker_id text not null,
 sender_phone text not null check (sender_phone ~ '^[0-9]{10,15}$'),
 display_name text not null,
 version text not null check (version = 'broker-dm-capture-v1'),
 confirmed_by uuid not null references auth.users(id),
 confirmed_at timestamptz not null default now(),
 revoked_at timestamptz,
 primary key (organization_id, whatsapp_connection_id, sender_phone)
);
alter table public.broker_dm_capture_senders enable row level security;
revoke all on public.broker_dm_capture_senders from public,anon,authenticated;
grant select,insert,update,delete on public.broker_dm_capture_senders to service_role;

-- Serialized with connection identity changes. Validation precedes every write.
-- p_senders is a jsonb array of {"phone": "...", "name": "..."} objects; each
-- phone must normalize to 10-15 digits. Enabling records the confirmation for
-- every requested sender in one transaction; disabling revokes the requested
-- senders. Nothing outside the request is created or touched.
create function public.broker_dm_capture_set_senders(
 p_tenant uuid, p_connection bigint, p_senders jsonb, p_actor uuid, p_version text, p_enabled boolean
) returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare
 c public.org_whatsapp_connections;
 wanted jsonb;
 changed integer;
begin
 if p_version is distinct from 'broker-dm-capture-v1' or p_enabled is null then
  raise exception 'Current direct-message capture confirmation is required';
 end if;
 select * into c from public.org_whatsapp_connections
 where id=p_connection and organization_id=p_tenant for update;
 if not found or c.is_active is not true or coalesce(c.broker_id,'')='' then
  raise exception 'Active workspace connection not found';
 end if;
 if p_senders is null or jsonb_typeof(p_senders) <> 'array'
 or jsonb_array_length(p_senders) not between 1 and 100
 or exists(select 1 from jsonb_array_elements(p_senders) s
   where jsonb_typeof(s) <> 'object'
      or not (s ? 'phone')
      or regexp_replace(coalesce(s->>'phone',''),'[^0-9]','','g') !~ '^[0-9]{10,15}$') then
  raise exception 'Choose between 1 and 100 exact sender phone numbers';
 end if;
 select jsonb_agg(distinct jsonb_build_object(
   'phone', regexp_replace(s->>'phone','[^0-9]','','g'),
   'name', nullif(btrim(coalesce(s->>'name','')),'')
 ) order by jsonb_build_object(
   'phone', regexp_replace(s->>'phone','[^0-9]','','g'),
   'name', nullif(btrim(coalesce(s->>'name','')),'')
 )) into wanted from jsonb_array_elements(p_senders) s;
 -- The connection lock serializes with the revoke trigger below.
 if p_enabled then
  insert into public.broker_dm_capture_senders as old
   (organization_id,whatsapp_connection_id,broker_id,sender_phone,display_name,version,confirmed_by,confirmed_at,revoked_at)
  select p_tenant,p_connection,c.broker_id,s->>'phone',coalesce(s->>'name',s->>'phone'),
   p_version,p_actor,now(),null
  from jsonb_array_elements(wanted) s
  on conflict (organization_id,whatsapp_connection_id,sender_phone) do update set
   broker_id=excluded.broker_id,display_name=excluded.display_name,version=excluded.version,
   confirmed_by=case when old.revoked_at is null and old.broker_id=excluded.broker_id then old.confirmed_by else excluded.confirmed_by end,
   confirmed_at=case when old.revoked_at is null and old.broker_id=excluded.broker_id then old.confirmed_at else excluded.confirmed_at end,
   revoked_at=null;
  get diagnostics changed=row_count;
 else
  update public.broker_dm_capture_senders set revoked_at=now()
   where organization_id=p_tenant and whatsapp_connection_id=p_connection
    and sender_phone in (select s->>'phone' from jsonb_array_elements(wanted) s)
    and revoked_at is null;
  get diagnostics changed=row_count;
 end if;
 return changed;
end $$;
revoke all on function public.broker_dm_capture_set_senders(uuid,bigint,jsonb,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.broker_dm_capture_set_senders(uuid,bigint,jsonb,uuid,text,boolean) to service_role;

-- Same fail-closed rule as raw sharing: a reconnect, phone-number change or
-- deactivation revokes direct-message capture designations. The rows stay as
-- the audit record; the owner can re-confirm after reviewing.
create function public.broker_dm_capture_revoke_connection() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.organization_id is distinct from old.organization_id
 or new.broker_id is distinct from old.broker_id
 or public.broker_market_phone_identity(new.phone_number) is distinct from public.broker_market_phone_identity(old.phone_number)
 or new.is_active is not true then
  update public.broker_dm_capture_senders set revoked_at=now()
   where whatsapp_connection_id=old.id and revoked_at is null;
 end if;
 return new;
end $$;
revoke all on function public.broker_dm_capture_revoke_connection() from public,anon,authenticated;
grant execute on function public.broker_dm_capture_revoke_connection() to service_role;

drop trigger if exists broker_dm_capture_revoke_connection on public.org_whatsapp_connections;
create trigger broker_dm_capture_revoke_connection
 after update on public.org_whatsapp_connections
 for each row execute function public.broker_dm_capture_revoke_connection();

commit;
