-- Preparation only: applying this migration does NOT opt any existing source in.
-- Source text remains in raw_messages under its owning tenant. No copied content.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '10s';
create table public.broker_market_source_consents (
  group_connection_id bigint primary key references public.organization_group_connections(id) on delete cascade,
  version text not null check (version = 'broker-property-cross-search-v1'),
  confirmed_by uuid not null references auth.users(id),
  confirmed_at timestamptz not null default now(),
  source_updated_at timestamptz not null,
  revoked_at timestamptz
);
alter table public.broker_market_source_consents enable row level security;
revoke all on public.broker_market_source_consents from public, anon, authenticated;
grant select,insert,update,delete on public.broker_market_source_consents to service_role;

-- Cosmetic directory refreshes do not change consent. Any eligibility loss or
-- source identity change revokes it permanently until a new explicit consent.
create function public.broker_market_revoke_changed_source() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if new.organization_id is distinct from old.organization_id
 or new.whatsapp_connection_id is distinct from old.whatsapp_connection_id
 or new.group_jid is distinct from old.group_jid
 or new.is_active is not true or new.opted_out is not false
 or new.public_market_source is not true then
  update public.broker_market_source_consents set revoked_at=now() where group_connection_id=old.id and revoked_at is null;
 end if;
 return new;
end $$;
create trigger broker_market_revoke_source before update on public.organization_group_connections
for each row execute function public.broker_market_revoke_changed_source();
revoke all on function public.broker_market_revoke_changed_source() from public,anon,authenticated;

-- Query support without copying text or building embeddings.
create index broker_market_source_time_idx on public.raw_messages
 (tenant_id, (split_part(event_id,':',1)), ((raw_payload #>> '{data,key,remoteJid}')), timestamp desc,id desc)
 where is_group is true and source='WHATSAPP' and pipeline_version='go-ingestor';
create index broker_market_text_fts_idx on public.raw_messages using gin (to_tsvector('english',message))
 where is_group is true and source='WHATSAPP' and pipeline_version='go-ingestor';

-- No arbitrary raw-message ID endpoint: API verifies a reader-bound signed search reference.
-- Both search and re-read use this exact source predicate, before pagination.
create view public.broker_market_eligible_source_rows as
 select r.id as raw_id, r.message as body, r.timestamp as posted_at, r.sender_phone, r.sender_jid
 from public.raw_messages r
 join public.org_whatsapp_connections c
   on c.organization_id = r.tenant_id
  and c.broker_id = split_part(r.event_id, ':', 1)
  and c.is_active is true
 join public.organization_group_connections g
   on g.organization_id = r.tenant_id
  and g.whatsapp_connection_id = c.id
  and g.group_jid = r.raw_payload #>> '{data,key,remoteJid}'
 join public.broker_market_source_consents consent on consent.group_connection_id = g.id
 where r.is_group is true and r.source = 'WHATSAPP'
   and r.pipeline_version = 'go-ingestor'
   and r.raw_payload #>> '{data,source}' is distinct from 'history_sync'
   and g.group_jid ~ '^[0-9-]+@g\.us$'
   and split_part(r.message_uid, ':', 1) = c.broker_id
   and split_part(r.message_uid, ':', 2) = g.group_jid
   and split_part(r.message_uid, ':', 3) <> ''
   and r.event_id = c.broker_id || ':' || split_part(r.message_uid, ':', 3)
   and r.message_uid = c.broker_id || ':' || g.group_jid || ':' || split_part(r.message_uid, ':', 3)
   and g.is_active is true and g.opted_out is false and g.public_market_source is true
   and consent.version = 'broker-property-cross-search-v1'
   and consent.revoked_at is null
   -- Forward-only: late historical captures do not become public after consent.
   and r.synced_at >= consent.confirmed_at and r.timestamp >= consent.confirmed_at;
revoke all on public.broker_market_eligible_source_rows from public,anon,authenticated;
grant select on public.broker_market_eligible_source_rows to service_role;
create function public.broker_market_eligible_rows()
returns table (raw_id bigint, body text, posted_at timestamptz, sender_phone text, sender_jid text)
language sql stable security definer set search_path=public,pg_temp
as $$ select * from public.broker_market_eligible_source_rows $$;
revoke all on function public.broker_market_eligible_rows() from public,anon,authenticated;
grant execute on function public.broker_market_eligible_rows() to service_role;

create function public.broker_market_search(
 p_terms jsonb, p_property_pattern text, p_since timestamptz, p_until timestamptz,
 p_limit integer default 11, p_last_id bigint default null, p_last_at timestamptz default null
) returns table(raw_id bigint, body text, posted_at timestamptz,sender_phone text,sender_jid text)
language sql stable security definer set search_path=public,pg_temp set statement_timeout='4s'
as $$
 select r.raw_id, r.body, r.posted_at,r.sender_phone,r.sender_jid from public.broker_market_eligible_source_rows r
 where p_limit between 1 and 21
   and p_since >= p_until - interval '90 days' and p_until >= p_since
   and jsonb_typeof(p_terms) = 'array' and jsonb_array_length(p_terms) between 1 and 5
   and r.posted_at >= p_since and r.posted_at <= p_until
   and (p_last_id is null or (r.posted_at,r.raw_id) < (p_last_at,p_last_id))
   and to_tsvector('english',r.body) @@ websearch_to_tsquery('english',
     (select string_agg('"' || replace(term,'"','') || '"',' OR ')
      from jsonb_array_elements(p_terms) term_group, jsonb_array_elements_text(term_group) term))
   and r.body ~* p_property_pattern
   and not exists (
     select 1 from jsonb_array_elements(p_terms) term_group
     where not exists (
       select 1 from jsonb_array_elements_text(term_group) term
       where length(term) between 2 and 100 and lower(r.body) like '%' || replace(replace(replace(lower(term),'\','\\'),'%','\%'),'_','\_') || '%' escape '\'
     )
   )
 order by r.posted_at desc,r.raw_id desc limit least(greatest(p_limit,1),21)
$$;
revoke all on function public.broker_market_search(jsonb,text,timestamptz,timestamptz,integer,bigint,timestamptz) from public,anon,authenticated;
grant execute on function public.broker_market_search(jsonb,text,timestamptz,timestamptz,integer,bigint,timestamptz) to service_role;

create function public.broker_market_get(p_raw_id bigint)
returns table(raw_id bigint,body text,posted_at timestamptz,sender_phone text,sender_jid text)
language sql stable security definer set search_path=public,pg_temp set statement_timeout='4s'
as $$ select * from public.broker_market_eligible_source_rows where raw_id=p_raw_id limit 1 $$;
revoke all on function public.broker_market_get(bigint) from public,anon,authenticated;
grant execute on function public.broker_market_get(bigint) to service_role;

-- Cross-worker rate limits. No source content or search phrases stored.
create table public.broker_market_rate_windows (
 reader text not null, operation text not null, window_start timestamptz not null,
 uses integer not null, primary key(reader,operation,window_start)
);
alter table public.broker_market_rate_windows enable row level security;
revoke all on public.broker_market_rate_windows from public,anon,authenticated;
create function public.broker_market_take_rate(p_reader text,p_operation text)
returns boolean language plpgsql security definer set search_path=public,pg_temp set statement_timeout='2s'
as $$
declare used integer; cap integer;
begin
 if p_reader='' or p_operation not in ('search','get','contact') then return false; end if;
 cap := case when p_operation='contact' then 10 else 60 end;
 insert into public.broker_market_rate_windows values(p_reader,p_operation,date_trunc('hour',now()),1)
 on conflict(reader,operation,window_start) do update set uses=broker_market_rate_windows.uses+1
 returning uses into used;
 -- Fixed-size expiry cleanup is independent of source history.
 delete from public.broker_market_rate_windows where window_start < now()-interval '2 days';
 return used <= cap;
end $$;
revoke all on function public.broker_market_take_rate(text,text) from public,anon,authenticated;
grant execute on function public.broker_market_take_rate(text,text) to service_role;
-- Atomic per-scope edit prevents reintroducing a concurrently removed write scope.
create function public.broker_market_set_key_access(p_tenant uuid,p_key uuid,p_enabled boolean)
returns table(id uuid,scopes text[]) language sql security definer set search_path=public,pg_temp set statement_timeout='2s'
as $$
 update public.external_agent_api_keys k set scopes = case when p_enabled
 then array_append(array_remove(k.scopes,'broker_market:read'),'broker_market:read')
 else array_remove(k.scopes,'broker_market:read') end
 where k.tenant_id=p_tenant and k.id=p_key and k.revoked_at is null
 returning k.id,k.scopes
$$;
revoke all on function public.broker_market_set_key_access(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.broker_market_set_key_access(uuid,uuid,boolean) to service_role;
commit;
