-- The onboarding API stores an explicit opt-out state per group. The original
-- table only had is_active, which made every settings lookup fail through the
-- Data API once the endpoint started filtering on opted_out.
alter table public.organization_group_connections
  add column if not exists opted_out boolean not null default false;

create index if not exists idx_org_group_connections_opted_out
  on public.organization_group_connections(organization_id, whatsapp_connection_id, opted_out);
