create table if not exists public.billing_subscriptions (
  id bigint generated always as identity primary key,
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  plan_key text not null check (plan_key in ('solo', 'two_numbers', 'three_numbers')),
  razorpay_subscription_id text not null unique,
  razorpay_payment_id text,
  status text not null default 'created' check (status in ('created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed')),
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.billing_webhook_events (
  id bigint generated always as identity primary key,
  event_id text not null unique,
  event text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.billing_subscriptions enable row level security;
alter table public.billing_webhook_events enable row level security;

create policy "billing members can read own subscription"
  on public.billing_subscriptions for select to authenticated
  using (exists (
    select 1 from public.organization_members m
    where m.organization_id = billing_subscriptions.organization_id
      and m.user_id = (select auth.uid()) and m.is_active
  ));

create policy "billing webhook events are service role only"
  on public.billing_webhook_events for all to authenticated
  using (false) with check (false);

create index if not exists billing_subscriptions_org_status_idx
  on public.billing_subscriptions (organization_id, status);

comment on table public.billing_subscriptions is 'Tenant-scoped Razorpay subscription state; secrets and webhook payloads remain server-side.';
