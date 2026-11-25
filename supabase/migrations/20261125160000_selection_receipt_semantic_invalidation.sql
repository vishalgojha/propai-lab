-- Receipt invalidation must follow semantic selection changes only.
--
-- The atomic confirmation receipt proves the user reviewed the current
-- selection. Two volatile elements let background bookkeeping invalidate it:
--   * the organization_group_connections trigger blanked state_fingerprint on
--     EVERY insert/update/delete, including pure bookkeeping touches
--     (updated_at bumps, group_name refreshes) that change nothing the user
--     confirmed;
--   * the fingerprint embedded g.updated_at, so any such touch also changed
--     the fingerprint itself.
-- A completed confirm could therefore be silently invalidated by background
-- writes with no user action, re-greying Start (the 2026-11-25 incident).
--
-- This migration keeps the connection/devices/allowlist behavior exactly as
-- before (the connection trigger was already semantic-only) and narrows only
-- the group-row handling: the trigger skips UPDATEs that change no semantic
-- field, and the fingerprint drops g.updated_at. Parameter names are kept
-- (p_tenant, p_connection) so CREATE OR REPLACE applies without a drop.

begin;

set local lock_timeout='2s';
set local statement_timeout='15s';

create or replace function public.invalidate_whatsapp_group_selection() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 if TG_TABLE_NAME='org_whatsapp_connections' then
  if new.organization_id is distinct from old.organization_id or new.broker_id is distinct from old.broker_id or new.phone_number is distinct from old.phone_number or new.is_active is distinct from old.is_active then
   update whatsapp_group_selection_receipts set state_fingerprint='' where whatsapp_connection_id=old.id;
  end if;
 elsif TG_TABLE_NAME='organization_group_connections' then
  if TG_OP='UPDATE' then
   -- Bookkeeping-only touches (updated_at, group_name, other non-semantic
   -- columns) must not invalidate a completed receipt.
   if new.is_active is not distinct from old.is_active and new.opted_out is not distinct from old.opted_out and new.public_market_source is not distinct from old.public_market_source and new.group_jid is not distinct from old.group_jid then
    return new;
   end if;
   update whatsapp_group_selection_receipts set state_fingerprint='' where whatsapp_connection_id=old.whatsapp_connection_id;
   return new;
  end if;
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

create or replace function public.whatsapp_group_selection_fingerprint(p_tenant uuid,p_connection bigint)
returns text language sql stable security definer set search_path=public,pg_temp as $$
 select md5(jsonb_build_array(
  (select jsonb_build_array(c.organization_id,c.broker_id,c.phone_number,c.is_active) from org_whatsapp_connections c where c.id=p_connection and c.organization_id=p_tenant),
  (select coalesce(jsonb_agg(to_jsonb(d) order by d.whatsapp_connection_key),'[]'::jsonb) from broker_whatsapp_devices d join org_whatsapp_connections c on c.broker_id=d.whatsapp_connection_key where c.id=p_connection and c.organization_id=p_tenant),
  (select coalesce(jsonb_agg(to_jsonb(a) order by a.whatsapp_connection_id),'[]'::jsonb) from public_market_publication_allowlist a where a.tenant_id=p_tenant),
  (select coalesce(jsonb_agg(jsonb_build_array(g.group_jid,g.is_active,g.opted_out,g.public_market_source) order by g.group_jid),'[]'::jsonb) from organization_group_connections g where g.organization_id=p_tenant and g.whatsapp_connection_id=p_connection)
 )::text)
$$;

notify pgrst, 'reload schema';

commit;
