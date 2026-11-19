-- Preparation only: applying this migration does NOT grant any MCP reader
-- cross-search access. Rows are created one by one when a workspace owner
-- explicitly enables property cross-search for their own MCP sign-in
-- (Account → Integrations), and revoked_at ends it immediately.
--
-- This is the MCP counterpart of the REST per-key broker_market:read scope:
-- the reader is the actual (organization, auth user) pair of the signed-in
-- MCP connection, never a fabricated API key. It grants reader access only;
-- it does not consent the broker's own groups for sharing, add DMs, or
-- enable writes.
begin;
create table public.broker_market_mcp_reader_grants (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  granted_by uuid not null references auth.users(id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  primary key (organization_id, user_id)
);
alter table public.broker_market_mcp_reader_grants enable row level security;
revoke all on public.broker_market_mcp_reader_grants from public, anon, authenticated;
grant select,insert,update,delete on public.broker_market_mcp_reader_grants to service_role;

-- Atomic grant/revoke for one MCP reader, mirroring
-- broker_market_set_key_access for REST keys. The API owner endpoint calls
-- this after its workspace-permission gate; a revoke is one row update and
-- takes effect on the reader's next tool call.
create function public.broker_market_set_mcp_reader_access(p_tenant uuid, p_user uuid, p_enabled boolean, p_actor uuid)
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
  update public.broker_market_mcp_reader_grants g set revoked_at=now()
   where g.organization_id=p_tenant and g.user_id=p_user and g.revoked_at is null;
 end if;
 return query select p_tenant, p_user, p_enabled;
end $$;
revoke all on function public.broker_market_set_mcp_reader_access(uuid,uuid,boolean,uuid) from public,anon,authenticated;
grant execute on function public.broker_market_set_mcp_reader_access(uuid,uuid,boolean,uuid) to service_role;
commit;
