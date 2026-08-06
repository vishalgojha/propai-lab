-- Per-user notification sound selections for the internal dashboard.
alter table public.user_profiles
  add column if not exists sound_preferences jsonb not null default '{}'::jsonb;
