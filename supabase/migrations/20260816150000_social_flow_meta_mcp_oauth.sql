create table if not exists public.social_flow_meta_mcp_connections (
  tenant_id uuid primary key references public.organizations(id) on delete cascade,
  access_token_encrypted text not null,
  refresh_token_encrypted text,
  token_type text not null default 'Bearer',
  expires_at timestamptz,
  scopes text[] not null default '{}',
  connected_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.social_flow_meta_mcp_oauth_states (
  state text primary key,
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  code_verifier text not null,
  redirect_uri text not null,
  client_id text,
  client_secret_encrypted text,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.social_flow_meta_mcp_connections enable row level security;
alter table public.social_flow_meta_mcp_oauth_states enable row level security;

-- Tokens and PKCE state are API-private. The FastAPI service uses service_role;
-- no browser role receives table access.
revoke all on public.social_flow_meta_mcp_connections from anon, authenticated;
revoke all on public.social_flow_meta_mcp_oauth_states from anon, authenticated;

create index if not exists social_flow_meta_mcp_oauth_states_expires_idx
  on public.social_flow_meta_mcp_oauth_states (expires_at);
