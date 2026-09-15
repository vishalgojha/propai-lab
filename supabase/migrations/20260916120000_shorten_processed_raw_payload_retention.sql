-- Shorten the expensive full WhatsApp transport-payload window without
-- deleting source rows or the evidence needed by deduplication and audit.
--
-- Successful rows keep the complete payload for three days after processing:
-- 24 hours for extraction plus 48 hours for investigation/retries. Failed or
-- suppressed rows keep it for fourteen days so operational failures remain
-- diagnosable. After that, only the compact envelope below remains. The raw
-- message columns are intentionally never removed by this function.

create or replace function public.trim_processed_raw_payload(
  p_retention interval default interval '3 days',
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
       and processed_at is not null
       and raw_payload is not null
       and raw_payload <> '{}'::jsonb
       and coalesce(raw_payload->>'retained', '') <> 'compact'
       and (
         (
           extraction_outcome in ('succeeded', 'success')
           and processed_at < now() - p_retention
         )
         or (
           coalesce(extraction_outcome, '') not in ('succeeded', 'success')
           and processed_at < now() - interval '14 days'
         )
       )
     order by processed_at, id
     limit greatest(1, least(coalesce(p_batch_size, 5000), 20000))
     for update skip locked
  )
  update public.raw_messages r
     set raw_payload = jsonb_strip_nulls(jsonb_build_object(
           'retained', 'compact',
           'compacted_at', now(),
           'full_text', nullif(r.message, ''),
           'source', nullif(r.source, ''),
           'source_scope', nullif(r.raw_payload->>'source_scope', ''),
           'visibility', nullif(r.raw_payload->>'visibility', ''),
           'data', jsonb_strip_nulls(jsonb_build_object(
             'broker_id', coalesce(
               nullif(r.raw_payload #>> '{data,broker_id}', ''),
               nullif(r.raw_payload->>'broker_id', '')
             ),
             'instance', coalesce(
               nullif(r.raw_payload #>> '{data,instance}', ''),
               nullif(r.raw_payload->>'instance', '')
             ),
             'conversationName', coalesce(
               nullif(r.raw_payload #>> '{data,conversationName}', ''),
               nullif(r.raw_payload->>'conversationName', ''),
               nullif(r.group_name, '')
             ),
             'pushName', nullif(r.raw_payload #>> '{data,pushName}', ''),
             'key', jsonb_strip_nulls(jsonb_build_object(
               'remoteJid', coalesce(
                 nullif(r.raw_payload #>> '{data,key,remoteJid}', ''),
                 nullif(r.raw_payload #>> '{key,remoteJid}', ''),
                 nullif(r.group_name, '')
               ),
               'id', coalesce(
                 nullif(r.raw_payload #>> '{data,key,id}', ''),
                 nullif(r.raw_payload #>> '{key,id}', ''),
                 nullif(r.message_uid, '')
               ),
               'participant', coalesce(
                 nullif(r.raw_payload #>> '{data,key,participant}', ''),
                 nullif(r.raw_payload #>> '{key,participant}', ''),
                 nullif(r.sender_jid, '')
               ),
               'fromMe', coalesce(
                 nullif(r.raw_payload #>> '{data,key,fromMe}', ''),
                 nullif(r.raw_payload #>> '{key,fromMe}', '')
               )
             ))
           ))
         )),
         attachments = '[]'::jsonb,
         reply_context = '{}'::jsonb
    from candidates c
   where r.id = c.id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.trim_processed_raw_payload(interval, integer)
  from public, anon, authenticated;
grant execute on function public.trim_processed_raw_payload(interval, integer)
  to service_role;

-- Replace the old 30-day schedule. Keep this conditional for environments
-- where pg_cron is not installed.
do $cron$
declare
  v_jobid bigint;
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    select jobid into v_jobid
      from cron.job
     where jobname = 'propai-raw-payload-retention';

    if v_jobid is not null then
      perform cron.unschedule(v_jobid);
    end if;

    perform cron.schedule(
      'propai-raw-payload-retention',
      '*/15 * * * *',
      $job$select public.trim_processed_raw_payload(interval '3 days', 5000);$job$
    );
  end if;
end;
$cron$;

comment on function public.trim_processed_raw_payload(interval, integer) is
  'Compacts successful raw WhatsApp payloads after 3 days and failed/suppressed payloads after 14 days; source rows and compact evidence remain.';
