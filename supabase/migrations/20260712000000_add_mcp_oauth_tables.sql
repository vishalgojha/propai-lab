-- ============================================================================
-- MCP OAuth Tables for Dynamic Client Registration & PKCE
-- ============================================================================

-- mcp_oauth_clients
create table if not exists public.mcp_oauth_clients (
  client_id text primary key,
  client_name text not null,
  redirect_uris text[] not null,
  grant_types text[] not null,
  response_types text[] not null,
  token_endpoint_auth_method text not null default 'none',
  created_at timestamptz not null default now()
);

-- mcp_oauth_codes
create table if not exists public.mcp_oauth_codes (
  code text primary key,
  client_id text not null references public.mcp_oauth_clients(client_id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  code_challenge_method text not null default 'S256',
  access_token text not null,
  refresh_token text,
  expires_in integer not null,
  created_at timestamptz not null default now()
);

create index if not exists mcp_oauth_codes_created_at_idx on public.mcp_oauth_codes (created_at);

alter table public.mcp_oauth_clients enable row level security;
alter table public.mcp_oauth_codes enable row level security;

-- No public policies by design. The MCP server uses the service role key,
-- which bypasses RLS, while browser/client-side Supabase calls cannot read
-- or mutate OAuth client registrations or authorization codes.
