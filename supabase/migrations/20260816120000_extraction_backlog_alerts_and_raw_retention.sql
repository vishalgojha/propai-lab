-- Extraction backlog alerting and bounded raw evidence retention.
--
-- This migration is intentionally safe to apply before any cleanup run:
-- alerting is durable, and retention processes only successful rows older
-- than the configured window in small SKIP LOCKED batches.

create table if not exists public.pipeline_alerts (
  id bigint generated always as identity primary key,
  alert_key text not null unique,
  alert_type text not null,
  severity text not null default 'warning'
    check (severity in ('info', 'warning', 'critical')),
  status text not null default 'open'
    check (status in ('open', 'resolved')),
  observed_day date,
  details jsonb not null default '{}'::jsonb,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists pipeline_alerts_status_seen_idx
  on public.pipeline_alerts (status, last_seen_at desc);
create index if not exists pipeline_alerts_type_day_idx
  on public.pipeline_alerts (alert_type, observed_day desc);

alter table public.pipeline_alerts enable row level security;
revoke all on table public.pipeline_alerts from anon, authenticated;
grant all on table public.pipeline_alerts to service_role;
grant usage, select on sequence public.pipeline_alerts_id_seq to service_role;

create or replace function public.check_extraction_backlog_alerts()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_observed_day date := (now() at time zone 'UTC')::date - 1;
  v_pending bigint := 0;
  v_trailing_avg numeric := 0;
  v_threshold numeric := 0;
  v_alert_key text;
  v_details jsonb;
begin
  select count(*) into v_pending
  from public.raw_messages
  where created_at >= v_observed_day::timestamptz
    and created_at < (v_observed_day + 1)::timestamptz
    and processed = false;

  select coalesce(avg(day_pending), 0)
    into v_trailing_avg
  from (
    select d::date as day,
           (select count(*)
              from public.raw_messages r
             where r.created_at >= d
               and r.created_at < d + interval '1 day'
               and r.processed = false) as day_pending
      from generate_series(
        v_observed_day - interval '7 days',
        v_observed_day - interval '1 day',
        interval '1 day'
      ) d
  ) daily;

  v_threshold := greatest(1000::numeric, v_trailing_avg * 3);
  v_alert_key := 'raw-extraction-backlog:' || v_observed_day::text;
  v_details := jsonb_build_object(
    'observed_day', v_observed_day,
    'pending_rows', v_pending,
    'trailing_7_day_average', round(v_trailing_avg, 2),
    'threshold_rows', round(v_threshold, 2),
    'ratio', case when v_trailing_avg > 0
      then round(v_pending / v_trailing_avg, 2) else null end,
    'rule', 'daily unprocessed rows exceed 3x trailing 7-day average'
  );

  if v_pending >= v_threshold then
    insert into public.pipeline_alerts(
      alert_key, alert_type, severity, status, observed_day, details
    ) values (
      v_alert_key, 'raw_extraction_backlog', 'critical', 'open',
      v_observed_day, v_details
    )
    on conflict (alert_key) do update
      set severity = 'critical',
          status = 'open',
          details = excluded.details,
          last_seen_at = now(),
          resolved_at = null;

    perform pg_notify(
      'propai_pipeline_alert',
      jsonb_build_object(
        'alert_key', v_alert_key,
        'alert_type', 'raw_extraction_backlog',
        'severity', 'critical',
        'details', v_details
      )::text
    );
  end if;

  return jsonb_build_object(
    'observed_day', v_observed_day,
    'pending_rows', v_pending,
    'trailing_7_day_average', round(v_trailing_avg, 2),
    'threshold_rows', round(v_threshold, 2),
    'alerted', v_pending >= v_threshold
  );
end;
$$;

revoke all on function public.check_extraction_backlog_alerts() from public, anon, authenticated;
grant execute on function public.check_extraction_backlog_alerts() to service_role;

create or replace function public.trim_processed_raw_payload(
  p_retention interval default interval '30 days',
  p_batch_size integer default 5000
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count bigint := 0;
begin
  with candidates as (
    select id
      from public.raw_messages
     where processed = true
       and extraction_outcome in ('succeeded', 'success')
       and processed_at < now() - p_retention
       and raw_payload is not null
       and raw_payload <> '{}'::jsonb
     order by processed_at, id
     limit greatest(1, least(coalesce(p_batch_size, 5000), 20000))
     for update skip locked
  )
  update public.raw_messages r
     set raw_payload = jsonb_build_object(
           'retained', 'trimmed',
           'trimmed_at', now()
         ),
         attachments = '[]'::jsonb,
         reply_context = '{}'::jsonb
    from candidates c
   where r.id = c.id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create index if not exists idx_raw_messages_retention_candidates
  on public.raw_messages (processed_at, id)
  where processed = true
    and extraction_outcome in ('succeeded', 'success');

revoke all on function public.trim_processed_raw_payload(interval, integer)
  from public, anon, authenticated;
grant execute on function public.trim_processed_raw_payload(interval, integer)
  to service_role;

-- pg_cron is optional in local/dev environments. The durable tables/functions
-- still work without it and can be called by the app scheduler instead.
do $cron$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    if not exists (select 1 from cron.job where jobname = 'propai-extraction-backlog-alert') then
      perform cron.schedule(
        'propai-extraction-backlog-alert',
        '20 0 * * *',
        $job$select public.check_extraction_backlog_alerts();$job$
      );
    end if;
    if not exists (select 1 from cron.job where jobname = 'propai-raw-payload-retention') then
      perform cron.schedule(
        'propai-raw-payload-retention',
        '*/15 * * * *',
        $job$select public.trim_processed_raw_payload(interval '30 days', 5000);$job$
      );
    end if;
  end if;
end;
$cron$;
