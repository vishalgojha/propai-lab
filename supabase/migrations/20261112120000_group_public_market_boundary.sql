-- Explicit publication boundary for WhatsApp-derived market data.
-- Raw messages remain tenant-owned. Only explicitly selected groups may produce
-- shared-market typed rows; direct messages can never become public inventory.

alter table public.organization_group_connections
  add column if not exists public_market_source boolean not null default false;

create index if not exists idx_org_group_connections_public_market
  on public.organization_group_connections(organization_id, whatsapp_connection_id, group_jid)
  where public_market_source = true and is_active = true and opted_out = false;

-- Existing confirmed selections are the only safe historical promotion. Rows
-- that were never selected, including DMs, become workspace-private.
update public.organization_group_connections
set public_market_source = (is_active = true and opted_out = false)
;

create or replace function public.raw_message_has_public_group_source(p_raw_message_id bigint)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $fn$
  select exists (
    select 1
    from public.raw_messages raw
    join public.organization_group_connections group_source
      on group_source.organization_id = raw.tenant_id
     and (
       group_source.group_jid = coalesce(raw.raw_payload -> 'key' ->> 'remoteJid', raw.raw_payload ->> 'remoteJid', '')
       or group_source.group_name = coalesce(raw.group_name, '')
     )
    where raw.id = p_raw_message_id
      and raw.is_group = true
      and group_source.is_active = true
      and group_source.opted_out = false
      and group_source.public_market_source = true
  );
$fn$;

revoke all on function public.raw_message_has_public_group_source(bigint) from public, anon, authenticated;
grant execute on function public.raw_message_has_public_group_source(bigint) to service_role;

create or replace function public.apply_raw_market_visibility()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $fn$
begin
  if new.raw_message_id is not null then
    if public.raw_message_has_public_group_source(new.raw_message_id) then
      new.visibility := 'shared_market';
      new.source_scope := 'whatsapp_group_public';
    else
      new.visibility := 'workspace_private';
      new.source_scope := 'whatsapp_private';
    end if;
  end if;
  return new;
end;
$fn$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'residential_sale_listings', 'residential_rent_listings',
    'commercial_sale_listings', 'commercial_rent_listings',
    'residential_sale_requirements', 'residential_rent_requirements',
    'commercial_sale_requirements', 'commercial_rent_requirements'
  ] loop
    execute format('drop trigger if exists trg_%s_market_visibility on public.%I', table_name, table_name);
    execute format('create trigger trg_%s_market_visibility before insert or update of raw_message_id on public.%I for each row execute function public.apply_raw_market_visibility()', table_name, table_name);
    execute format('update public.%I typed set visibility = case when public.raw_message_has_public_group_source(typed.raw_message_id) then ''shared_market'' else ''workspace_private'' end, source_scope = case when public.raw_message_has_public_group_source(typed.raw_message_id) then ''whatsapp_group_public'' else ''whatsapp_private'' end where typed.raw_message_id is not null', table_name);
  end loop;
end;
$$;

create or replace function public.sync_group_market_visibility(
  p_organization_id uuid,
  p_group_jid text,
  p_group_name text,
  p_public_market_source boolean
)
returns integer
language plpgsql security definer
set search_path = public, pg_temp
as $fn$
declare table_name text; changed integer := 0; result_count integer;
begin
  foreach table_name in array array[
    'residential_sale_listings', 'residential_rent_listings',
    'commercial_sale_listings', 'commercial_rent_listings',
    'residential_sale_requirements', 'residential_rent_requirements',
    'commercial_sale_requirements', 'commercial_rent_requirements'
  ] loop
    execute format('update public.%I typed set visibility = case when $4 then ''shared_market'' else ''workspace_private'' end, source_scope = case when $4 then ''whatsapp_group_public'' else ''whatsapp_private'' end from public.raw_messages raw where typed.raw_message_id = raw.id and raw.tenant_id = $1 and raw.is_group = true and (raw.group_name = $3 or raw.raw_payload -> ''key'' ->> ''remoteJid'' = $2)', table_name)
      using p_organization_id, p_group_jid, p_group_name, p_public_market_source;
    get diagnostics result_count = row_count;
    changed := changed + result_count;
  end loop;
  return changed;
end;
$fn$;

revoke all on function public.sync_group_market_visibility(uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.sync_group_market_visibility(uuid, text, text, boolean) to service_role;

-- The anonymous projection must be backed by an explicit shared-market row.
-- Keep the existing privacy-shaped card-fact columns unchanged.
create or replace view public.listings_unified_public as
select
  l.*,
  case
    when l.card_type = 'residential_sale' then (select r.bathroom_count from public.residential_sale_listings r where r.id = l.id)
    when l.card_type = 'residential_rent' then (select r.bathroom_count from public.residential_rent_listings r where r.id = l.id)
    else null
  end as bathroom_count,
  case
    when l.card_type = 'residential_sale' then (select r.car_parking_count from public.residential_sale_listings r where r.id = l.id)
    when l.card_type = 'residential_rent' then (select r.car_parking_count from public.residential_rent_listings r where r.id = l.id)
    when l.card_type = 'commercial_sale' then (select r.car_parking_count from public.commercial_sale_listings r where r.id = l.id)
    when l.card_type = 'commercial_rent' then (select r.car_parking_count from public.commercial_rent_listings r where r.id = l.id)
    else null
  end as car_parking_count,
  case
    when l.card_type = 'residential_sale' then (select r.parking_type from public.residential_sale_listings r where r.id = l.id)
    when l.card_type = 'residential_rent' then (select r.parking_type from public.residential_rent_listings r where r.id = l.id)
    when l.card_type = 'commercial_sale' then (select r.parking_type from public.commercial_sale_listings r where r.id = l.id)
    when l.card_type = 'commercial_rent' then (select r.parking_type from public.commercial_rent_listings r where r.id = l.id)
    else null
  end as parking_type,
  case
    when l.card_type = 'commercial_sale' then (select r.has_lift from public.commercial_sale_listings r where r.id = l.id)
    when l.card_type = 'commercial_rent' then (select r.has_lift from public.commercial_rent_listings r where r.id = l.id)
    else null
  end as has_lift,
  case
    when l.card_type = 'commercial_sale' then (select r.has_power_backup from public.commercial_sale_listings r where r.id = l.id)
    when l.card_type = 'commercial_rent' then (select r.has_power_backup from public.commercial_rent_listings r where r.id = l.id)
    else null
  end as has_power_backup
from public.listings_unified_public_legacy l
where exists (select 1 from public.residential_sale_listings r where l.card_type = 'residential_sale' and r.id = l.id and r.visibility = 'shared_market')
   or exists (select 1 from public.residential_rent_listings r where l.card_type = 'residential_rent' and r.id = l.id and r.visibility = 'shared_market')
   or exists (select 1 from public.commercial_sale_listings r where l.card_type = 'commercial_sale' and r.id = l.id and r.visibility = 'shared_market')
   or exists (select 1 from public.commercial_rent_listings r where l.card_type = 'commercial_rent' and r.id = l.id and r.visibility = 'shared_market');

grant select on public.listings_unified_public to anon, authenticated;
notify pgrst, 'reload schema';
