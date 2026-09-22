-- Data retention: recurring prune functions + one-time purge of processed raw
-- messages (reclaims most of raw_messages' ~3.8 GB). Every row-level reference to
-- raw_messages via NO ACTION FKs (enrichment_jobs, observation_evidence,
-- jid_profiles.last_message_id, evaluations, listings_legacy, repeat_of_raw_message_id)
-- is explicitly guarded so citing rows are never orphaned or deleted. SET NULL FKs
-- (follow_ups, client_property_candidates, extraction_learning_examples) are safe
-- for deletes and do not need guards.

create or replace function public.prune_raw_messages(
    p_older_than interval default interval '3 days',
    p_batch integer default 5000
) returns integer language plpgsql set search_path = public as $fn$
declare
    v_deleted integer := 0;
    v_batch integer;
    v_cutoff timestamptz := now() - coalesce(p_older_than, interval '3 days');
begin
    lock table public.raw_messages in share row exclusive mode;
    loop
        delete from public.raw_messages r
         where r.processed
           and r.processed_at < v_cutoff
           and not exists (select 1 from public.enrichment_jobs e where e.raw_message_id = r.id)
           and not exists (select 1 from public.observation_evidence o where o.raw_message_id = r.id)
           and not exists (select 1 from public.evaluations v where v.raw_message_id = r.id)
           and not exists (select 1 from public.jid_profiles j where j.last_message_id = r.id)
           and not exists (select 1 from public.listings_legacy l where l.latest_raw_message_id = r.id or l.representative_raw_message_id = r.id)
           and not exists (select 1 from public.raw_messages d where d.repeat_of_raw_message_id = r.id)
           and r.id in (
               select id from public.raw_messages
                where processed and processed_at < v_cutoff
                limit p_batch
           );
        get diagnostics v_batch = row_count;
        exit when v_batch = 0;
        v_deleted := v_deleted + v_batch;
        perform pg_sleep(0.05);
    end loop;
    return v_deleted;
end $fn$;

comment on function public.prune_raw_messages(interval, integer) is
  'Deletes processed raw WhatsApp messages older than the cutoff that are not still cited by enrichment jobs, observation evidence, evaluations, jid profiles, listings_legacy, or duplicate links.';

create or replace function public.prune_whatsapp_events(
    p_older_than interval default interval '60 days',
    p_batch integer default 50000
) returns integer language plpgsql set search_path = public as $fn$
declare
    v_deleted integer := 0;
    v_batch integer;
begin
    loop
        delete from public.whatsapp_events
         where created_at < now() - coalesce(p_older_than, interval '60 days')
           and id in (
               select id from public.whatsapp_events
                where created_at < now() - coalesce(p_older_than, interval '60 days')
                limit p_batch
           );
        get diagnostics v_batch = row_count;
        exit when v_batch = 0;
        v_deleted := v_deleted + v_batch;
        perform pg_sleep(0.05);
    end loop;
    return v_deleted;
end $fn$;

comment on function public.prune_whatsapp_events(interval, integer) is
  'Deletes whatsapp event-log rows older than the retention window.';

create or replace function public.prune_extraction_attempt_log(
    p_older_than interval default interval '30 days',
    p_batch integer default 50000
) returns integer language plpgsql set search_path = public as $fn$
declare
    v_deleted integer := 0;
    v_batch integer;
begin
    loop
        delete from public.extraction_attempt_log
         where started_at < now() - coalesce(p_older_than, interval '30 days')
           and id in (
               select id from public.extraction_attempt_log
                where started_at < now() - coalesce(p_older_than, interval '30 days')
                limit p_batch
           );
        get diagnostics v_batch = row_count;
        exit when v_batch = 0;
        v_deleted := v_deleted + v_batch;
        perform pg_sleep(0.05);
    end loop;
    return v_deleted;
end $fn$;

comment on function public.prune_extraction_attempt_log(interval, integer) is
  'Deletes extraction attempt-log rows older than the retention window.';

create or replace function public.prune_ai_usage_log(
    p_older_than interval default interval '90 days',
    p_batch integer default 100000
) returns integer language plpgsql set search_path = public as $fn$
declare
    v_deleted integer := 0;
    v_batch integer;
begin
    loop
        delete from public.ai_usage_log
         where created_at < now() - coalesce(p_older_than, interval '90 days')
           and id in (
               select id from public.ai_usage_log
                where created_at < now() - coalesce(p_older_than, interval '90 days')
                limit p_batch
           );
        get diagnostics v_batch = row_count;
        exit when v_batch = 0;
        v_deleted := v_deleted + v_batch;
        perform pg_sleep(0.05);
    end loop;
    return v_deleted;
end $fn$;

comment on function public.prune_ai_usage_log(interval, integer) is
  'Deletes AI usage-log rows older than the retention window.';

create or replace function public.prune_extraction_cache(
    p_inactive interval default interval '90 days',
    p_batch integer default 50000
) returns integer language plpgsql set search_path = public as $fn$
declare
    v_deleted integer := 0;
    v_batch integer;
begin
    loop
        delete from public.extraction_cache
         where coalesce(last_hit_at, created_at) < now() - coalesce(p_inactive, interval '90 days')
           and id in (
               select id from public.extraction_cache
                where coalesce(last_hit_at, created_at) < now() - coalesce(p_inactive, interval '90 days')
                limit p_batch
           );
        get diagnostics v_batch = row_count;
        exit when v_batch = 0;
        v_deleted := v_deleted + v_batch;
        perform pg_sleep(0.05);
    end loop;
    return v_deleted;
end $fn$;

comment on function public.prune_extraction_cache(interval, integer) is
  'Evicts extraction-cache entries not hit within the inactivity window.';

create or replace function public.prune_semantic_embedding_jobs(
    p_older_than interval default interval '7 days',
    p_batch integer default 5000
) returns integer language plpgsql set search_path = public as $fn$
declare
    v_deleted integer := 0;
    v_batch integer;
begin
    loop
        delete from public.semantic_embedding_jobs
         where status in ('completed', 'failed')
           and completed_at < now() - coalesce(p_older_than, interval '7 days')
           and id in (
               select id from public.semantic_embedding_jobs
                where status in ('completed', 'failed')
                  and completed_at < now() - coalesce(p_older_than, interval '7 days')
                limit p_batch
           );
        get diagnostics v_batch = row_count;
        exit when v_batch = 0;
        v_deleted := v_deleted + v_batch;
        perform pg_sleep(0.05);
    end loop;
    return v_deleted;
end $fn$;

comment on function public.prune_semantic_embedding_jobs(interval, integer) is
  'Deletes completed/failed embedding-job rows older than the retention window; pending/running are never touched.';

-- One-time purge on apply. Keeps the last 3 days of processed raw messages.
select public.prune_raw_messages(interval '3 days');
select public.prune_whatsapp_events(interval '60 days');
select public.prune_extraction_attempt_log(interval '30 days');
select public.prune_ai_usage_log(interval '90 days');
select public.prune_extraction_cache(interval '90 days');
select public.prune_semantic_embedding_jobs(interval '7 days');

-- Nightly schedule (staggered, off-peak) only when pg_cron exists.
do $cron$
declare
    v_jobid bigint;
begin
    if exists (select 1 from pg_namespace where nspname = 'cron') then
        select jobid into v_jobid from cron.job where jobname = 'propai-raw-messages-retention';
        if v_jobid is not null then perform cron.unschedule(v_jobid); end if;
        perform cron.schedule(
            'propai-raw-messages-retention',
            '30 0 * * *',
            $job$select public.prune_raw_messages(interval '3 days');$job$
        );

        select jobid into v_jobid from cron.job where jobname = 'propai-whatsapp-events-retention';
        if v_jobid is not null then perform cron.unschedule(v_jobid); end if;
        perform cron.schedule(
            'propai-whatsapp-events-retention',
            '0 1 * * *',
            $job$select public.prune_whatsapp_events(interval '60 days');$job$
        );

        select jobid into v_jobid from cron.job where jobname = 'propai-extraction-attempt-log-retention';
        if v_jobid is not null then perform cron.unschedule(v_jobid); end if;
        perform cron.schedule(
            'propai-extraction-attempt-log-retention',
            '30 1 * * *',
            $job$select public.prune_extraction_attempt_log(interval '30 days');$job$
        );

        select jobid into v_jobid from cron.job where jobname = 'propai-ai-usage-log-retention';
        if v_jobid is not null then perform cron.unschedule(v_jobid); end if;
        perform cron.schedule(
            'propai-ai-usage-log-retention',
            '0 2 * * *',
            $job$select public.prune_ai_usage_log(interval '90 days');$job$
        );

        select jobid into v_jobid from cron.job where jobname = 'propai-extraction-cache-retention';
        if v_jobid is not null then perform cron.unschedule(v_jobid); end if;
        perform cron.schedule(
            'propai-extraction-cache-retention',
            '30 2 * * *',
            $job$select public.prune_extraction_cache(interval '90 days');$job$
        );

        select jobid into v_jobid from cron.job where jobname = 'propai-semantic-embedding-jobs-retention';
        if v_jobid is not null then perform cron.unschedule(v_jobid); end if;
        perform cron.schedule(
            'propai-semantic-embedding-jobs-retention',
            '0 4 * * *',
            $job$select public.prune_semantic_embedding_jobs(interval '7 days');$job$
        );
    end if;
end;
$cron$;

analyze public.raw_messages;
analyze public.whatsapp_events;
analyze public.extraction_attempt_log;
analyze public.ai_usage_log;
analyze public.extraction_cache;
analyze public.semantic_embedding_jobs;