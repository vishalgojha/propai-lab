-- Durable Operations Agent run status. Runs are detached tasks polled by the
-- UI. The API runs multiple uvicorn workers, so per-process status (an
-- in-memory dict on the worker that received the POST) is invisible to the
-- worker serving the poll, which surfaced as "Operations Agent run not found".
-- The run envelope lives here so any worker can serve the current status.

create table if not exists public.operations_agent_runs (
  id uuid primary key,
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid references public.operations_agent_sessions(id) on delete set null,
  status text not null default 'queued' check (status in ('queued','running','completed','failed')),
  stage text not null default 'Queued',
  content text not null default '',
  model text not null default '',
  usage jsonb not null default '{}'::jsonb,
  approval jsonb,
  error text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_operations_agent_runs_owner
  on public.operations_agent_runs(tenant_id, user_id, created_at desc);

alter table public.operations_agent_runs enable row level security;

drop policy if exists operations_agent_runs_owner on public.operations_agent_runs;
create policy operations_agent_runs_owner on public.operations_agent_runs
  for all using (public.is_super_admin() or (tenant_id = any(select public.user_tenant_ids()) and user_id = auth.uid()))
  with check (public.is_super_admin() or (tenant_id = any(select public.user_tenant_ids()) and user_id = auth.uid()));