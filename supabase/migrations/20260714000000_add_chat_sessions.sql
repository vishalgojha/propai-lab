-- ============================================================================
-- Persistent AI Chat Sessions
-- ============================================================================

-- ai_chat_sessions
create table if not exists public.ai_chat_sessions (
  id uuid primary key default gen_random_uuid(),
  broker_phone text not null,
  title text not null default 'New chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ai_chat_messages
create table if not exists public.ai_chat_messages (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.ai_chat_sessions(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists ai_chat_sessions_broker_phone_idx
  on public.ai_chat_sessions (broker_phone, updated_at desc);

create index if not exists ai_chat_messages_session_id_idx
  on public.ai_chat_messages (session_id, created_at);

alter table public.ai_chat_sessions enable row level security;
alter table public.ai_chat_messages enable row level security;

-- No public policies by design. The API server uses the service role key,
-- which bypasses RLS.
