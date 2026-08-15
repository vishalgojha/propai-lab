create table if not exists public.social_flow_meta_settings (
  tenant_id uuid primary key references public.organizations(id) on delete cascade,
  page_id text,
  ad_account_id text,
  destination text,
  currency text not null default 'INR',
  timezone text not null default 'Asia/Kolkata',
  default_daily_budget numeric(12,2),
  setup_status text not null default 'needs_setup' check (setup_status in ('needs_setup', 'ready')),
  meta_connection_status text not null default 'not_connected' check (meta_connection_status in ('not_connected', 'connected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.social_flow_meta_settings enable row level security;

drop policy if exists "organization members can read social flow meta settings" on public.social_flow_meta_settings;
create policy "organization members can read social flow meta settings"
  on public.social_flow_meta_settings for select to authenticated
  using (exists (
    select 1 from public.organization_members member
    where member.organization_id = social_flow_meta_settings.tenant_id
      and member.user_id = auth.uid()
      and member.is_active = true
  ));

create or replace function public.touch_social_flow_meta_settings_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists social_flow_meta_settings_updated_at on public.social_flow_meta_settings;
create trigger social_flow_meta_settings_updated_at
before update on public.social_flow_meta_settings
for each row execute function public.touch_social_flow_meta_settings_updated_at();
