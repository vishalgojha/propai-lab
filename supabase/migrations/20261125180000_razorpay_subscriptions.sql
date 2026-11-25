-- Razorpay subscription billing for PropAI workspace plans.
-- Inert until live Razorpay plan IDs and keys are configured; applied only
-- after billing authority is settled. No existing trial columns change.

create table if not exists public.subscription_plans (
  code text primary key,
  name text not null,
  monthly_price_inr integer not null,
  whatsapp_numbers integer not null,
  razorpay_plan_id text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Price points from the Nov 25 pricing direction; number mapping per tier.
insert into public.subscription_plans (code, name, monthly_price_inr, whatsapp_numbers)
values
  ('solo', 'Solo (1 number)', 1299, 1),
  ('two_numbers', 'Two numbers', 1499, 2),
  ('three_numbers', 'Three numbers', 2599, 3)
on conflict (code) do nothing;

create table if not exists public.tenant_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.organizations(id),
  plan_code text not null references public.subscription_plans(code),
  razorpay_subscription_id text unique,
  razorpay_customer_id text,
  short_url text,
  status text not null default 'created',
  start_at timestamptz,
  trial_ends_at timestamptz,
  current_period_end timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tenant_subscriptions_tenant
  on public.tenant_subscriptions(tenant_id, created_at desc);

create table if not exists public.razorpay_webhook_events (
  id uuid primary key default gen_random_uuid(),
  razorpay_event_id text unique,
  event_type text not null,
  payload jsonb not null,
  processed_at timestamptz,
  created_at timestamptz not null default now()
);
