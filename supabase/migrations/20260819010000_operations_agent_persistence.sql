-- Durable PropAI Operations Agent state.
-- Browser localStorage is only a cache; sessions, memory, and task state live
-- in the workspace database so the agent survives browsers and deployments.

create table if not exists public.operations_agent_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New session',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.operations_agent_messages (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  session_id uuid not null references public.operations_agent_sessions(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'tool', 'system')),
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.operations_agent_memory (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  memory_key text not null,
  memory_value jsonb not null default '{}'::jsonb,
  source_session_id uuid references public.operations_agent_sessions(id) on delete set null,
  confidence numeric(4,3) not null default 1.0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, user_id, memory_key)
);

create table if not exists public.operations_agent_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid references public.operations_agent_sessions(id) on delete set null,
  task_type text not null,
  status text not null default 'proposed' check (status in ('proposed','approved','running','succeeded','failed','cancelled')),
  request text not null default '',
  payload jsonb not null default '{}'::jsonb,
  result jsonb not null default '{}'::jsonb,
  error text not null default '',
  approval_required boolean not null default true,
  approved_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_operations_agent_sessions_owner
  on public.operations_agent_sessions(tenant_id, user_id, updated_at desc);
create index if not exists idx_operations_agent_messages_session
  on public.operations_agent_messages(tenant_id, session_id, created_at);
create index if not exists idx_operations_agent_memory_owner
  on public.operations_agent_memory(tenant_id, user_id, updated_at desc);
create index if not exists idx_operations_agent_tasks_owner
  on public.operations_agent_tasks(tenant_id, user_id, created_at desc);

alter table public.operations_agent_sessions enable row level security;
alter table public.operations_agent_messages enable row level security;
alter table public.operations_agent_memory enable row level security;
alter table public.operations_agent_tasks enable row level security;

drop policy if exists operations_agent_sessions_owner on public.operations_agent_sessions;
create policy operations_agent_sessions_owner on public.operations_agent_sessions
  for all using (public.is_super_admin() or (tenant_id = any(select public.user_tenant_ids()) and user_id = auth.uid()))
  with check (public.is_super_admin() or (tenant_id = any(select public.user_tenant_ids()) and user_id = auth.uid()));

drop policy if exists operations_agent_messages_owner on public.operations_agent_messages;
create policy operations_agent_messages_owner on public.operations_agent_messages
  for all using (public.is_super_admin() or (tenant_id = any(select public.user_tenant_ids()) and exists (
    select 1 from public.operations_agent_sessions s where s.id = session_id and s.user_id = auth.uid()
  )))
  with check (public.is_super_admin() or (tenant_id = any(select public.user_tenant_ids()) and exists (
    select 1 from public.operations_agent_sessions s where s.id = session_id and s.user_id = auth.uid()
  )));

drop policy if exists operations_agent_memory_owner on public.operations_agent_memory;
create policy operations_agent_memory_owner on public.operations_agent_memory
  for all using (public.is_super_admin() or (tenant_id = any(select public.user_tenant_ids()) and user_id = auth.uid()))
  with check (public.is_super_admin() or (tenant_id = any(select public.user_tenant_ids()) and user_id = auth.uid()));

drop policy if exists operations_agent_tasks_owner on public.operations_agent_tasks;
create policy operations_agent_tasks_owner on public.operations_agent_tasks
  for all using (public.is_super_admin() or (tenant_id = any(select public.user_tenant_ids()) and user_id = auth.uid()))
  with check (public.is_super_admin() or (tenant_id = any(select public.user_tenant_ids()) and user_id = auth.uid()));
