-- Give every raw WhatsApp message a finite parsing window.
-- Raw evidence is retained; only the extraction queue state becomes terminal.

alter table public.extraction_reprocessing_jobs
  drop constraint if exists extraction_reprocessing_jobs_status_check;

alter table public.extraction_reprocessing_jobs
  add constraint extraction_reprocessing_jobs_status_check check (status in (
    'queued', 'running', 'fixed', 'still_unresolved', 'no_source', 'failed',
    'expired'
  ));

create or replace function public.skip_expired_extraction_messages(
  p_age_hours integer default 24,
  p_limit integer default 500
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  with expired as (
    select id
      from public.raw_messages
     where processed = false
       and is_group = true
       and created_at <= now() - make_interval(hours => greatest(1, least(coalesce(p_age_hours, 24), 168)))
       and coalesce(extraction_outcome, '') <> 'running'
     order by created_at, id
     for update skip locked
     limit greatest(1, least(coalesce(p_limit, 500), 1000))
  ), marked as (
    update public.raw_messages r
       set processed = true,
           processed_at = now(),
           extraction_suppressed = true,
           extraction_outcome = 'skipped:retry_window_expired',
           extraction_last_error = 'Skipped after the 24-hour extraction window expired'
      from expired e
     where r.id = e.id
     returning r.id, r.tenant_id, r.extraction_attempts
  )
  insert into public.extraction_attempt_log(
    raw_message_id, tenant_id, lane, attempt_number, status, reason, completed_at
  )
  select id, tenant_id, 'expiry', extraction_attempts, 'skipped',
         '24-hour extraction window expired', now()
    from marked;

  get diagnostics v_count = row_count;
  return coalesce(v_count, 0);
end;
$$;

revoke all on function public.skip_expired_extraction_messages(integer, integer)
  from public, anon, authenticated;
grant execute on function public.skip_expired_extraction_messages(integer, integer)
  to service_role;

notify pgrst, 'reload schema';
