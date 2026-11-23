-- Preparation only. No existing source or contact grants are activated.
begin;
set local lock_timeout='2s';
set local statement_timeout='10s';
create table public.broker_market_contact_consents (
 organization_id uuid not null,
 whatsapp_connection_id bigint not null,
 group_jid text not null,
 broker_id text not null,
 raw_confirmed_at timestamptz not null,
 version text not null check(version='broker-property-contact-results-v1'),
 confirmed_by uuid not null references auth.users(id),
 confirmed_at timestamptz not null default now(),
 revoked_at timestamptz,
 primary key(organization_id,whatsapp_connection_id,group_jid),
 foreign key(organization_id,whatsapp_connection_id,group_jid)
 references public.broker_market_raw_source_consents(organization_id,whatsapp_connection_id,group_jid) on delete cascade
);
alter table public.broker_market_contact_consents enable row level security;
revoke all on public.broker_market_contact_consents from public,anon,authenticated;
grant select,insert,update,delete on public.broker_market_contact_consents to service_role;

create function public.broker_market_revoke_contact_consent() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.revoked_at is not null or new.broker_id is distinct from old.broker_id
 or new.confirmed_at is distinct from old.confirmed_at or new.version is distinct from old.version then
  update public.broker_market_contact_consents set revoked_at=now()
  where organization_id=old.organization_id and whatsapp_connection_id=old.whatsapp_connection_id
   and group_jid=old.group_jid and revoked_at is null;
 end if;
 return new;
end $$;
create trigger broker_market_contact_parent_changed after update on public.broker_market_raw_source_consents
for each row execute function public.broker_market_revoke_contact_consent();
revoke all on function public.broker_market_revoke_contact_consent() from public,anon,authenticated;

create function public.broker_market_set_contact_sources(
 p_tenant uuid,p_connection bigint,p_groups text[],p_actor uuid,p_version text,p_enabled boolean
) returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare c public.org_whatsapp_connections; wanted text[]; changed integer;
begin
 if p_version is distinct from 'broker-property-contact-results-v1' or p_enabled is null then raise exception 'Current contact sharing confirmation required'; end if;
 select * into c from public.org_whatsapp_connections where id=p_connection and organization_id=p_tenant for update;
 if not found or c.is_active is not true then raise exception 'Active workspace connection required'; end if;
 if p_groups is null or cardinality(p_groups) not between 1 and 200 or exists(select 1 from unnest(p_groups) g where g is null or g !~ '^[0-9-]+@g\.us$') then raise exception 'Choose exact groups'; end if;
 select array_agg(distinct g order by g) into wanted from unnest(p_groups) g;
 if p_enabled then
  perform 1 from public.broker_market_raw_source_consents where organization_id=p_tenant and whatsapp_connection_id=p_connection and group_jid=any(wanted) for update;
  if exists(select 1 from unnest(wanted) g where not exists(select 1 from public.broker_market_raw_source_consents s where s.organization_id=p_tenant and s.whatsapp_connection_id=p_connection and s.group_jid=g and s.broker_id=c.broker_id and s.version='broker-property-cross-search-v2' and s.revoked_at is null)) then raise exception 'Current raw sharing consent required for every group'; end if;
  if exists(select 1 from public.organization_group_connections p where p.organization_id=p_tenant and p.whatsapp_connection_id=p_connection and p.group_jid=any(wanted) and p.opted_out is true) then raise exception 'Source opted out'; end if;
  insert into public.broker_market_contact_consents as old
  select s.organization_id,s.whatsapp_connection_id,s.group_jid,s.broker_id,s.confirmed_at,p_version,p_actor,now(),null
  from public.broker_market_raw_source_consents s where s.organization_id=p_tenant and s.whatsapp_connection_id=p_connection and s.group_jid=any(wanted)
  on conflict(organization_id,whatsapp_connection_id,group_jid) do update set
   broker_id=excluded.broker_id,raw_confirmed_at=excluded.raw_confirmed_at,version=excluded.version,
   confirmed_by=case when old.revoked_at is null and old.broker_id=excluded.broker_id and old.raw_confirmed_at=excluded.raw_confirmed_at then old.confirmed_by else excluded.confirmed_by end,
   confirmed_at=case when old.revoked_at is null and old.broker_id=excluded.broker_id and old.raw_confirmed_at=excluded.raw_confirmed_at then old.confirmed_at else excluded.confirmed_at end,revoked_at=null;
  get diagnostics changed=row_count;
 else
  update public.broker_market_contact_consents set revoked_at=now() where organization_id=p_tenant and whatsapp_connection_id=p_connection and group_jid=any(wanted) and revoked_at is null;
  get diagnostics changed=row_count;
 end if;
 return changed;
end $$;
revoke all on function public.broker_market_set_contact_sources(uuid,bigint,text[],uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.broker_market_set_contact_sources(uuid,bigint,text[],uuid,text,boolean) to service_role;

-- Called only for rows already admitted by the unchanged source predicate.
create function public.broker_market_contact_allowed(p_raw_id bigint) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from public.broker_market_eligible_source_rows e
 join public.raw_messages r on r.id=e.raw_id
 join public.broker_market_raw_source_consents s on s.organization_id=r.tenant_id and s.broker_id=split_part(r.event_id,':',1) and s.group_jid=r.raw_payload #>> '{data,key,remoteJid}'
 join public.org_whatsapp_connections c on c.id=s.whatsapp_connection_id and c.organization_id=s.organization_id and c.broker_id=s.broker_id and c.is_active is true
 join public.broker_market_contact_consents g on g.organization_id=s.organization_id and g.whatsapp_connection_id=s.whatsapp_connection_id and g.group_jid=s.group_jid
 where e.raw_id=p_raw_id and s.revoked_at is null and s.version='broker-property-cross-search-v2'
 and not exists(select 1 from public.organization_group_connections p where p.organization_id=s.organization_id and p.whatsapp_connection_id=s.whatsapp_connection_id and p.group_jid=s.group_jid and p.opted_out is true)
 and g.broker_id=s.broker_id and g.raw_confirmed_at=s.confirmed_at and g.version='broker-property-contact-results-v1' and g.revoked_at is null
 and r.timestamp>=g.confirmed_at and r.synced_at>=g.confirmed_at)
$$;
revoke all on function public.broker_market_contact_allowed(bigint) from public,anon,authenticated;
grant execute on function public.broker_market_contact_allowed(bigint) to service_role;
create function public.broker_market_search_with_contacts(p_terms jsonb,p_property_pattern text,p_since timestamptz,p_until timestamptz,p_limit integer default 11,p_last_id bigint default null,p_last_at timestamptz default null)
returns table(raw_id bigint,body text,posted_at timestamptz,sender_phone text,sender_jid text,automatic_contacts boolean)
language sql stable security definer set search_path=public,pg_temp set statement_timeout='4s' as $$
 select s.*, public.broker_market_contact_allowed(s.raw_id) from public.broker_market_search(p_terms,p_property_pattern,p_since,p_until,p_limit,p_last_id,p_last_at) s
$$;
create function public.broker_market_get_with_contacts(p_raw_id bigint)
returns table(raw_id bigint,body text,posted_at timestamptz,sender_phone text,sender_jid text,automatic_contacts boolean)
language sql stable security definer set search_path=public,pg_temp set statement_timeout='4s' as $$
 select s.*, public.broker_market_contact_allowed(s.raw_id) from public.broker_market_get(p_raw_id) s
$$;
revoke all on function public.broker_market_search_with_contacts(jsonb,text,timestamptz,timestamptz,integer,bigint,timestamptz) from public,anon,authenticated;
revoke all on function public.broker_market_get_with_contacts(bigint) from public,anon,authenticated;
grant execute on function public.broker_market_search_with_contacts(jsonb,text,timestamptz,timestamptz,integer,bigint,timestamptz) to service_role;
grant execute on function public.broker_market_get_with_contacts(bigint) to service_role;
commit;
