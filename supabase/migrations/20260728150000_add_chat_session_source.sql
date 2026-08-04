alter table public.ai_chat_sessions
  add column if not exists source text not null default 'parsed'
  check (source in ('groups', 'parsed'));

create index if not exists idx_ai_chat_sessions_source
  on public.ai_chat_sessions (source);
