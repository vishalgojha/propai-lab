-- Broker usage events: count authenticated app searches separately from
-- assistant API calls and automation, so the product can show each broker's
-- actual activity without mixing in automated checks.
--
-- Stores workspace ID, WHICH surface, WHAT kind of action
-- and WHEN only. No user ID, API-key ID, query text, filters, content or results.
--
-- origin:
--   app                 = completed authenticated product search request
--                         (not proof of human initiation)
--   automation          = standing-search runs, or a call that carries the
--                         explicit X-PropAI-Initiator: automation header
--   assistant_unlabeled = any other assistant/API call
-- Unlabeled assistant calls are never added to app-endpoint request counts.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '10s';

create table public.broker_usage_events (
  id bigserial primary key,
  tenant_id uuid not null,
  surface text not null check (surface in ('app', 'assistant')),
  action text not null check (action in ('search')),
  origin text not null check (origin in ('app', 'automation', 'assistant_unlabeled')),
  created_at timestamptz not null default now()
);
create index broker_usage_events_tenant_created_idx on public.broker_usage_events (tenant_id, created_at desc);
alter table public.broker_usage_events enable row level security;
create policy service_role_all_broker_usage_events on public.broker_usage_events for ALL to service_role using (true) with check (true);
grant select, insert on public.broker_usage_events to service_role;
grant usage, select on sequence public.broker_usage_events_id_seq to service_role;
commit;
