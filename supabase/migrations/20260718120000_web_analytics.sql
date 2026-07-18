-- Anonymous web analytics for the public www site. No user accounts, no
-- sign-up friction: each visitor gets an anonymous visitor_id stored in a
-- cookie/localStorage, and events are logged server-side. This lets us measure
-- listing views, searches, contact clicks and shortlist/bundle actions without
-- ever forcing a login or collecting PII on the public surface.

create table if not exists public.web_analytics (
  id bigint generated always as identity primary key,
  visitor_id text not null,
  event text not null,
  listing_id bigint,
  query text,
  asset text,
  page text,
  payload jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists web_analytics_visitor_idx on public.web_analytics (visitor_id);
create index if not exists web_analytics_event_idx on public.web_analytics (event);
create index if not exists web_analytics_created_idx on public.web_analytics (created_at desc);

-- The public site never connects directly with an anon key for writes; the
-- /api/track route uses the service role. RLS is left enabled but with no
-- anon/authenticated policies so only the service role (server) can write,
-- and reads are restricted to the service role as well.
alter table public.web_analytics enable row level security;
