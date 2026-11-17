-- Isolated photo-only audit. Does not enable general CRM writes or approvals.
create table if not exists public.external_agent_photo_audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  api_key_id uuid references public.external_agent_api_keys(id) on delete set null,
  operation text not null check (operation in ('attach_photo','photo_permission_change')),
  status text not null check (status in ('started','succeeded','failed')),
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index if not exists external_agent_photo_audit_tenant_created_idx
  on public.external_agent_photo_audit_log(tenant_id,created_at desc);
alter table public.external_agent_photo_audit_log enable row level security;
revoke all on table public.external_agent_photo_audit_log from anon, authenticated, service_role;
grant select, insert, update on table public.external_agent_photo_audit_log to service_role;
drop policy if exists external_agent_photo_audit_service_all on public.external_agent_photo_audit_log;
create policy external_agent_photo_audit_service_all on public.external_agent_photo_audit_log
  for all to service_role using (true) with check (true);
