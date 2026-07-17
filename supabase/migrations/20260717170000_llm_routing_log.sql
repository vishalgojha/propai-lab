-- LiteLLM gateway routing log
-- Single dashboard for total LLM usage across every PropAI workload
-- (chat, extraction, classification, batch). Written by the gateway's
-- LiteLLM success/failure handlers (deploy/coolify/litellm/hooks.py).

create table if not exists public.llm_routing_log (
  id            bigint generated always as identity primary key,
  task_type     text not null,                       -- chat | extraction | classification | batch
  provider_used text not null,                       -- e.g. doubleword, groq, gemini-flash
  model_used    text,                                -- resolved model id
  success       boolean not null,
  latency_ms    integer,                             -- round-trip latency
  error_message text,                                -- set on failure
  tokens_used   integer,                             -- total tokens (prompt+completion)
  created_at    timestamptz not null default now()
);

create index if not exists llm_routing_log_created_at_idx
  on public.llm_routing_log (created_at desc);
create index if not exists llm_routing_log_provider_idx
  on public.llm_routing_log (provider_used, success, created_at desc);
create index if not exists llm_routing_log_task_type_idx
  on public.llm_routing_log (task_type, created_at desc);

-- Alerting query helper: failure rate per provider over the last N calls.
-- The alerting cron job (scripts/llm_gateway_alert.py) reuses this shape.
-- Returns providers whose failure rate exceeds the given threshold.
create or replace function public.llm_provider_failure_rates(
  p_window_minutes int default 30,
  p_min_calls int default 10,
  p_max_failure_rate float default 0.5
)
returns table (
  provider_used text,
  total_calls bigint,
  failed_calls bigint,
  failure_rate float,
  last_error_message text
)
language sql
as $$
  with recent as (
    select provider_used, success, error_message
    from public.llm_routing_log
    where created_at >= now() - (p_window_minutes || ' minutes')::interval
  ),
  agg as (
    select
      provider_used,
      count(*)::bigint as total_calls,
      count(*) filter (where not success)::bigint as failed_calls,
      (count(*) filter (where not success)::float / nullif(count(*), 0)) as failure_rate,
      (select error_message from recent r2
        where r2.provider_used = r.provider_used and r2.error_message is not null
        order by 1 desc limit 1) as last_error_message
    from recent r
    group by provider_used
  )
  select provider_used, total_calls, failed_calls, failure_rate, last_error_message
  from agg
  where total_calls >= p_min_calls and failure_rate > p_max_failure_rate
  order by failure_rate desc;
$$;
