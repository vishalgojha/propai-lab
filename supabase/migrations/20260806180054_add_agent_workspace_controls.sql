-- Workspace-scoped AI settings plus browser/agent tracing primitives.
-- Reuses the existing tenant/org model so keys, limits, and traces stay
-- partitioned by workspace.

do $$
begin
  create table if not exists public.workspace_ai_settings (
    id bigint primary key generated always as identity,
    tenant_id uuid not null references public.organizations(id) on delete cascade unique,
    monthly_budget_usd numeric(12,2),
    max_rpm integer not null default 60,
    max_concurrent_calls integer not null default 8,
    max_browser_sessions integer not null default 1,
    max_tool_rounds integer not null default 8,
    browser_enabled boolean not null default false,
    browser_provider text not null default 'browser-use',
    allowed_routes jsonb not null default '["/chat","/map","/listings/*","/brokers/*","/admin/*"]'::jsonb,
    allowed_actions jsonb not null default '["open","click","fill","select","scroll"]'::jsonb,
    notes text not null default '',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  create table if not exists public.agent_browser_sessions (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references public.organizations(id) on delete cascade,
    session_id uuid references public.ai_chat_sessions(id) on delete set null,
    user_id uuid references auth.users(id) on delete set null,
    browser_provider text not null default 'browser-use',
    task_label text not null default '',
    start_url text not null default '',
    current_url text not null default '',
    status text not null default 'open' check (status in ('open','running','closed','failed','cancelled','expired')),
    context jsonb not null default '{}'::jsonb,
    last_error text not null default '',
    started_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    closed_at timestamptz
  );

  create table if not exists public.agent_browser_steps (
    id bigint primary key generated always as identity,
    tenant_id uuid not null references public.organizations(id) on delete cascade,
    browser_session_id uuid not null references public.agent_browser_sessions(id) on delete cascade,
    step_index integer not null default 0,
    action text not null default '',
    target text not null default '',
    url text not null default '',
    status text not null default 'ok' check (status in ('ok','failed','skipped')),
    metadata jsonb not null default '{}'::jsonb,
    screenshot_url text not null default '',
    created_at timestamptz not null default now()
  );

  create table if not exists public.agent_audit_log (
    id bigint primary key generated always as identity,
    tenant_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid references auth.users(id) on delete set null,
    session_id uuid references public.ai_chat_sessions(id) on delete set null,
    browser_session_id uuid references public.agent_browser_sessions(id) on delete set null,
    event_type text not null,
    entity_type text not null default '',
    entity_id text not null default '',
    status text not null default 'logged',
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
  );
end $$;

create index if not exists idx_workspace_ai_settings_tenant
  on public.workspace_ai_settings(tenant_id);

create index if not exists idx_agent_browser_sessions_tenant
  on public.agent_browser_sessions(tenant_id);
create index if not exists idx_agent_browser_sessions_status
  on public.agent_browser_sessions(tenant_id, status);
create index if not exists idx_agent_browser_sessions_updated
  on public.agent_browser_sessions(updated_at desc);

create index if not exists idx_agent_browser_steps_session
  on public.agent_browser_steps(browser_session_id, step_index);
create index if not exists idx_agent_browser_steps_tenant
  on public.agent_browser_steps(tenant_id, created_at desc);

create index if not exists idx_agent_audit_log_tenant
  on public.agent_audit_log(tenant_id, created_at desc);
create index if not exists idx_agent_audit_log_session
  on public.agent_audit_log(session_id, created_at desc);

alter table public.workspace_ai_settings enable row level security;
drop policy if exists "tenant_select_workspace_ai_settings" on public.workspace_ai_settings;
create policy "tenant_select_workspace_ai_settings" on public.workspace_ai_settings
  for select
  using (
    public.is_super_admin() or
    tenant_id = any(select public.user_tenant_ids())
  );
drop policy if exists "tenant_insert_workspace_ai_settings" on public.workspace_ai_settings;
create policy "tenant_insert_workspace_ai_settings" on public.workspace_ai_settings
  for insert
  with check (
    public.is_super_admin() or
    tenant_id = any(select public.user_tenant_ids())
  );
drop policy if exists "tenant_update_workspace_ai_settings" on public.workspace_ai_settings;
create policy "tenant_update_workspace_ai_settings" on public.workspace_ai_settings
  for update
  using (
    public.is_super_admin() or
    tenant_id = any(select public.user_tenant_ids())
  )
  with check (
    public.is_super_admin() or
    tenant_id = any(select public.user_tenant_ids())
  );
drop policy if exists "tenant_delete_workspace_ai_settings" on public.workspace_ai_settings;
create policy "tenant_delete_workspace_ai_settings" on public.workspace_ai_settings
  for delete
  using (
    public.is_super_admin() or
    tenant_id = any(select public.user_tenant_ids())
  );

alter table public.agent_browser_sessions enable row level security;
drop policy if exists "tenant_select_agent_browser_sessions" on public.agent_browser_sessions;
create policy "tenant_select_agent_browser_sessions" on public.agent_browser_sessions
  for select
  using (
    public.is_super_admin() or
    tenant_id = any(select public.user_tenant_ids())
  );
drop policy if exists "tenant_insert_agent_browser_sessions" on public.agent_browser_sessions;
create policy "tenant_insert_agent_browser_sessions" on public.agent_browser_sessions
  for insert
  with check (
    public.is_super_admin() or
    tenant_id = any(select public.user_tenant_ids())
  );
drop policy if exists "tenant_update_agent_browser_sessions" on public.agent_browser_sessions;
create policy "tenant_update_agent_browser_sessions" on public.agent_browser_sessions
  for update
  using (
    public.is_super_admin() or
    tenant_id = any(select public.user_tenant_ids())
  )
  with check (
    public.is_super_admin() or
    tenant_id = any(select public.user_tenant_ids())
  );
drop policy if exists "tenant_delete_agent_browser_sessions" on public.agent_browser_sessions;
create policy "tenant_delete_agent_browser_sessions" on public.agent_browser_sessions
  for delete
  using (
    public.is_super_admin() or
    tenant_id = any(select public.user_tenant_ids())
  );

alter table public.agent_browser_steps enable row level security;
drop policy if exists "tenant_select_agent_browser_steps" on public.agent_browser_steps;
create policy "tenant_select_agent_browser_steps" on public.agent_browser_steps
  for select
  using (
    public.is_super_admin() or
    tenant_id = any(select public.user_tenant_ids())
  );
drop policy if exists "tenant_insert_agent_browser_steps" on public.agent_browser_steps;
create policy "tenant_insert_agent_browser_steps" on public.agent_browser_steps
  for insert
  with check (
    public.is_super_admin() or
    tenant_id = any(select public.user_tenant_ids())
  );
drop policy if exists "tenant_update_agent_browser_steps" on public.agent_browser_steps;
create policy "tenant_update_agent_browser_steps" on public.agent_browser_steps
  for update
  using (
    public.is_super_admin() or
    tenant_id = any(select public.user_tenant_ids())
  )
  with check (
    public.is_super_admin() or
    tenant_id = any(select public.user_tenant_ids())
  );
drop policy if exists "tenant_delete_agent_browser_steps" on public.agent_browser_steps;
create policy "tenant_delete_agent_browser_steps" on public.agent_browser_steps
  for delete
  using (
    public.is_super_admin() or
    tenant_id = any(select public.user_tenant_ids())
  );

alter table public.agent_audit_log enable row level security;
drop policy if exists "tenant_select_agent_audit_log" on public.agent_audit_log;
create policy "tenant_select_agent_audit_log" on public.agent_audit_log
  for select
  using (
    public.is_super_admin() or
    tenant_id = any(select public.user_tenant_ids())
  );
drop policy if exists "tenant_insert_agent_audit_log" on public.agent_audit_log;
create policy "tenant_insert_agent_audit_log" on public.agent_audit_log
  for insert
  with check (
    public.is_super_admin() or
    tenant_id = any(select public.user_tenant_ids())
  );
drop policy if exists "tenant_update_agent_audit_log" on public.agent_audit_log;
create policy "tenant_update_agent_audit_log" on public.agent_audit_log
  for update
  using (
    public.is_super_admin() or
    tenant_id = any(select public.user_tenant_ids())
  )
  with check (
    public.is_super_admin() or
    tenant_id = any(select public.user_tenant_ids())
  );
drop policy if exists "tenant_delete_agent_audit_log" on public.agent_audit_log;
create policy "tenant_delete_agent_audit_log" on public.agent_audit_log
  for delete
  using (
    public.is_super_admin() or
    tenant_id = any(select public.user_tenant_ids())
  );
