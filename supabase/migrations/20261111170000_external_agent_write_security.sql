-- External-agent credential rotation, write auditability, and owner approvals.
create table if not exists public.external_agent_write_audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  api_key_id uuid references public.external_agent_api_keys(id) on delete set null,
  actor_user_id uuid references auth.users(id) on delete set null,
  operation text not null,
  entity_type text not null default '',
  entity_id text not null default '',
  status text not null check (status in ('started', 'pending_approval', 'approved', 'succeeded', 'rejected', 'failed')),
  request_id text not null default '',
  idempotency_key text not null default '',
  sensitive_fields text[] not null default '{}',
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  error_code text not null default '',
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists external_agent_write_audit_tenant_created_idx
  on public.external_agent_write_audit_log(tenant_id, created_at desc);
create index if not exists external_agent_write_audit_key_created_idx
  on public.external_agent_write_audit_log(api_key_id, created_at desc);

create table if not exists public.external_agent_write_approvals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  audit_id uuid not null references public.external_agent_write_audit_log(id) on delete restrict,
  api_key_id uuid references public.external_agent_api_keys(id) on delete set null,
  operation text not null,
  entity_type text not null default '',
  payload jsonb not null default '{}'::jsonb,
  sensitive_fields text[] not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'expired')),
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references auth.users(id) on delete set null,
  decision_note text not null default ''
);

create index if not exists external_agent_write_approvals_tenant_status_idx
  on public.external_agent_write_approvals(tenant_id, status, requested_at desc);

alter table public.external_agent_api_keys
  add column if not exists replaced_by uuid references public.external_agent_api_keys(id) on delete set null;

alter table public.external_agent_write_audit_log enable row level security;
alter table public.external_agent_write_approvals enable row level security;

drop policy if exists external_agent_write_audit_member_select on public.external_agent_write_audit_log;
create policy external_agent_write_audit_member_select on public.external_agent_write_audit_log
  for select to authenticated
  using (tenant_id = any(select public.user_tenant_ids()));
drop policy if exists external_agent_write_audit_service_all on public.external_agent_write_audit_log;
create policy external_agent_write_audit_service_all on public.external_agent_write_audit_log
  for all to service_role using (true) with check (true);

drop policy if exists external_agent_write_approvals_member_select on public.external_agent_write_approvals;
create policy external_agent_write_approvals_member_select on public.external_agent_write_approvals
  for select to authenticated
  using (tenant_id = any(select public.user_tenant_ids()));
drop policy if exists external_agent_write_approvals_service_all on public.external_agent_write_approvals;
create policy external_agent_write_approvals_service_all on public.external_agent_write_approvals
  for all to service_role using (true) with check (true);

revoke all on table public.external_agent_write_audit_log from anon, authenticated;
grant select on table public.external_agent_write_audit_log to authenticated;
revoke all on table public.external_agent_write_approvals from anon, authenticated;
grant select on table public.external_agent_write_approvals to authenticated;
