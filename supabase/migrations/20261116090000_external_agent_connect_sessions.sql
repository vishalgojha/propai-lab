-- Broker-approved connect sessions for external agents (device-style flow).
-- The agent creates a session and polls by device code (stored hashed); a
-- signed-in workspace owner approves by short user code; the minted token is
-- returned to the agent exactly once, then cleared from the session row.
create table if not exists public.external_agent_connect_sessions (
  id uuid primary key default gen_random_uuid(),
  device_code_hash text not null unique,
  user_code text not null unique,
  label text not null default 'Instinct',
  write_access boolean not null default false,
  status text not null default 'pending',
  tenant_id uuid references public.organizations(id) on delete cascade,
  approved_by uuid references auth.users(id) on delete restrict,
  api_key_id uuid references public.external_agent_api_keys(id) on delete set null,
  token text,
  expires_at timestamptz not null,
  decided_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_external_agent_connect_sessions_user_code
  on public.external_agent_connect_sessions(user_code);
create index if not exists idx_external_agent_connect_sessions_expiry
  on public.external_agent_connect_sessions(expires_at)
  where status = 'pending';

alter table public.external_agent_connect_sessions enable row level security;
-- No member policies: sessions are only read and written by the API backend
-- with the service role. The broker-facing preview/approve/deny flow goes
-- through the API routes, which enforce authentication and org permission.
