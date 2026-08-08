-- A group already captured by PropAI's own WhatsApp number must not be
-- parsed a second time through a broker's connected phone.
alter table public.organization_group_connections
  add column if not exists network_owned boolean not null default false;

create index if not exists idx_group_members_propai_phone
  on public.group_members (tenant_id, member_phone, group_id);

create index if not exists idx_org_group_connections_network_owned
  on public.organization_group_connections (organization_id, network_owned);
