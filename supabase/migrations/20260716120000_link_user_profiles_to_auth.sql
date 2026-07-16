-- Profiles are owned by an authenticated user, not inferred from a phone number.
alter table public.user_profiles
  add column if not exists auth_user_id uuid references auth.users(id) on delete cascade;

with unique_profile_emails as (
  select lower(email) as email_key
  from public.user_profiles
  where coalesce(trim(email), '') <> ''
  group by lower(email)
  having count(*) = 1
)
update public.user_profiles as profile
set auth_user_id = auth_user.id
from auth.users as auth_user
join unique_profile_emails as unique_email
  on unique_email.email_key = lower(auth_user.email)
where profile.auth_user_id is null
  and lower(profile.email) = unique_email.email_key
  and not exists (
    select 1
    from public.user_profiles as claimed_profile
    where claimed_profile.auth_user_id = auth_user.id
  );

create unique index if not exists user_profiles_auth_user_id_key
  on public.user_profiles(auth_user_id)
  where auth_user_id is not null;

create index if not exists user_profiles_email_idx
  on public.user_profiles(lower(email));
