-- ============================================================================
-- Provider Outage Log
--
-- Persists per-probe results from a 60s background loop that hits every
-- configured LLM provider with a tiny "Respond with exactly: OK" prompt.
-- Used by /admin/providers to show uptime, recent failures, and 24h timeline.
--
-- Status enum:
--   ok      → HTTP 200 within timeout
--   slow    → HTTP 200 but latency above SLOW_LATENCY_THRESHOLD (5s)
--   timeout → httpx.TimeoutException
--   http    → non-200 HTTP response
--   error   → any other exception (network, dns, ssl, etc.)
--
-- Retention: a cleanup function removes rows older than 7 days.
-- Service-role only (no tenant scoping — outage evidence is global infra health).
-- ============================================================================

create table if not exists public.provider_outage_log (
  id bigserial primary key,
  ts timestamptz not null default now(),
  provider_id integer,
  provider_name text not null,
  provider_type text not null,
  model_name text,
  status text not null check (status in ('ok','slow','timeout','http','error')),
  latency_ms integer not null,
  http_status integer,
  error_kind text,
  error_msg text
);

create index if not exists idx_provider_outage_log_ts
  on public.provider_outage_log (ts desc);

create index if not exists idx_provider_outage_log_provider_ts
  on public.provider_outage_log (provider_name, ts desc);

create index if not exists idx_provider_outage_log_status_ts
  on public.provider_outage_log (status, ts desc)
  where status <> 'ok';

-- Retention helper: invoked by /api/admin/providers/cleanup and on startup.
create or replace function public.cleanup_provider_outage_log(retention_days int default 7)
returns int
language plpgsql
as $$
declare
  deleted_count int;
begin
  delete from public.provider_outage_log
  where ts < now() - make_interval(days => retention_days);
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

-- Service-role access only. The FastAPI service uses SUPABASE_SERVICE_KEY,
-- so it bypasses RLS by default; we still keep this strict so anon/authenticated
-- users (PostgREST clients) cannot read outage evidence directly.
alter table public.provider_outage_log enable row level security;

drop policy if exists "service_role all" on public.provider_outage_log;
create policy "service_role all" on public.provider_outage_log
  for all to service_role using (true) with check (true);

-- Super admins can read for the /admin/providers UI.
drop policy if exists "super_admin read" on public.provider_outage_log;
create policy "super_admin read" on public.provider_outage_log
  for select using (
    exists (
      select 1 from public.super_admins sa
      where sa.user_id = auth.uid()
    )
  );
