-- Add cached WhatsApp profile picture columns to user_profiles.

alter table public.user_profiles
  add column if not exists profile_photo_url text not null default '',
  add column if not exists profile_photo_id  text not null default '',
  add column if not exists profile_photo_fetched_at timestamptz;
