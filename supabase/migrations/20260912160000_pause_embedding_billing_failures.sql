-- HTTP 402 is a provider-account state, not a transient job failure. Exhaust
-- existing affected jobs so workers do not hot-loop while the account is
-- unfunded. A later operator-approved replay can reset these rows.
update public.semantic_embedding_jobs
set attempts = greatest(attempts, 5),
    scheduled_after = now() + interval '365 days',
    last_error = left('provider_paused: existing embedding provider HTTP 402; replay after billing is fixed', 1000),
    updated_at = now()
where status = 'failed'
  and (last_error ilike '%402 Payment Required%' or last_error ilike '%HTTP 402%');

-- This index was left invalid by a canceled concurrent build and cannot help
-- the planner. It is safe to remove the invalid object; valid indexes remain.
drop index if exists public.idx_raw_messages_progress_covering;
