-- Client accounts: signed-in people who use PropAI only through their own
-- assistant (public shared-market search). Not brokers: no organization, no
-- broker data. Role and contact rows are written only by the service role
-- (server-side client signup / client MCP tool). RLS is on with no policies,
-- so anon and authenticated roles cannot read or write either table.
create table if not exists public.client_accounts (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.client_contacts (
  auth_user_id uuid primary key references public.client_accounts(auth_user_id) on delete cascade,
  email text,
  full_name text not null,
  phone text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.client_accounts enable row level security;
alter table public.client_contacts enable row level security;
revoke all on public.client_accounts from anon, authenticated;
revoke all on public.client_contacts from anon, authenticated;
