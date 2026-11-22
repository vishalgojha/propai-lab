-- Shared-pool read default + group-review metadata.
--
-- 1. MCP reader access becomes a default of every NEW authorization: when a
--    workspace member completes an MCP sign-in consent,
--    broker_market_default_mcp_reader_grant inserts the reader grant ONLY if
--    no row exists yet. Existing connections are never upgraded silently,
--    and a recorded explicit disable (revoked_at set) is never resurrected.
--    The owner disable path must therefore INSERT a revoked row when none
--    exists, so a revocation survives any later re-authorization.
-- 2. broker_market_shared_sources returns the tenant's OWN current raw-group
--    sharing state with directory metadata (message volume, last activity),
--    never message content, so a broker's assistant can review which groups
--    are shared and suggest ones to uncheck. Suggestions only: unchecking
--    still requires the owner's explicit raw-sources confirmation.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '10s';

create or replace function public.broker_market_set_mcp_reader_access(p_tenant uuid, p_user uuid, p_enabled boolean, p_actor uuid)
returns table(organization_id uuid, user_id uuid, enabled boolean) language plpgsql security definer set search_path=public,pg_temp set statement_timeout='2s'
as $$
begin
 if p_enabled then
  insert into public.broker_market_mcp_reader_grants(organization_id,user_id,granted_by,granted_at,revoked_at)
  values(p_tenant,p_user,p_actor,now(),null)
  -- Constraint-name arbiter: the RETURNS TABLE output params are named
  -- organization_id/user_id and would shadow column names in a positional
  -- ON CONFLICT (org, user) target inside PL/pgSQL.
  on conflict on constraint broker_market_mcp_reader_grants_pkey do update set granted_by=p_actor, granted_at=now(), revoked_at=null;
 else
  -- An explicit disable must persist as a revoked row even when no row
  -- exists yet: only a recorded row blocks the new-authorization default
  -- grant, so a bare UPDATE of a missing row would lose the revocation.
  insert into public.broker_market_mcp_reader_grants(organization_id,user_id,granted_by,granted_at,revoked_at)
  values(p_tenant,p_user,p_actor,now(),now())
  on conflict on constraint broker_market_mcp_reader_grants_pkey do update set revoked_at=now();
 end if;
 return query select p_tenant, p_user, p_enabled;
end $$;
revoke all on function public.broker_market_set_mcp_reader_access(uuid,uuid,boolean,uuid) from public,anon,authenticated;
grant execute on function public.broker_market_set_mcp_reader_access(uuid,uuid,boolean,uuid) to service_role;

-- The new-authorization default grant. Insert-if-absent: a recorded row is
-- never touched, whether it is an enable or an explicit disable. Returns
-- true when this call created the grant.
create function public.broker_market_default_mcp_reader_grant(p_tenant uuid, p_user uuid, p_actor uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp set statement_timeout='2s'
as $$
begin
 insert into public.broker_market_mcp_reader_grants(organization_id,user_id,granted_by,granted_at,revoked_at)
 values(p_tenant,p_user,p_actor,now(),null)
 on conflict on constraint broker_market_mcp_reader_grants_pkey do nothing;
 return found;
end $$;
revoke all on function public.broker_market_default_mcp_reader_grant(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.broker_market_default_mcp_reader_grant(uuid,uuid,uuid) to service_role;

-- The reader's own tenant sharing state, for review suggestions. Returns only
-- group identifiers, names, consent timestamps and directory counters; no
-- message bodies, senders or other tenants' rows. Revoked consents never
-- appear, so a stale listing cannot outlive an owner uncheck.
create function public.broker_market_shared_sources(p_tenant uuid)
returns table(whatsapp_connection_id bigint, group_jid text, group_name text,
              confirmed_at timestamptz, message_count integer, last_message_at timestamptz)
language plpgsql security definer set search_path=public,pg_temp set statement_timeout='2s'
as $$
begin
 return query
 select c.whatsapp_connection_id, c.group_jid, c.group_name, c.confirmed_at,
        coalesce(d.message_count,0), d.last_message_at
 from public.broker_market_raw_source_consents c
 left join public.whatsapp_conversations d
   on d.tenant_id=c.organization_id and d.broker_id=c.broker_id
  and d.conversation_type='group' and d.conversation_jid=c.group_jid
 where c.organization_id=p_tenant and c.revoked_at is null
 order by c.group_name, c.group_jid;
end $$;
revoke all on function public.broker_market_shared_sources(uuid) from public,anon,authenticated;
grant execute on function public.broker_market_shared_sources(uuid) to service_role;
commit;
