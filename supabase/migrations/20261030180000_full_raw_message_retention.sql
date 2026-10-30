-- Full raw WhatsApp retention policy.
--
-- Raw messages are operational input, not the long-term inventory store. Keep
-- them for 30 days, then remove the row and any dependent evidence that cannot
-- survive without its source. Typed rows are intentionally allowed to cascade
-- away through their existing foreign keys, as approved by the owner.

create or replace function public.prune_raw_messages(
    p_older_than interval default interval '30 days',
    p_batch integer default 2000
) returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
    v_deleted bigint := 0;
    v_batch integer;
    v_cutoff timestamptz := now() - coalesce(p_older_than, interval '30 days');
    v_fk record;
    v_nullable boolean;
begin
    create temp table if not exists _propai_raw_retention_ids (
        id bigint primary key
    ) on commit drop;

    loop
        truncate _propai_raw_retention_ids;

        insert into _propai_raw_retention_ids (id)
        select id
          from public.raw_messages
         where created_at < v_cutoff
         order by created_at, id
         limit greatest(1, least(coalesce(p_batch, 2000), 10000))
         for update skip locked;

        get diagnostics v_batch = row_count;
        exit when v_batch = 0;

        -- Existing foreign keys with CASCADE/SET NULL are handled by Postgres.
        -- For older NO ACTION/RESTRICT references, remove or detach the child
        -- first so the raw source row can be deleted without orphaning FKs.
        for v_fk in
            select c.oid as constraint_oid,
                   c.conrelid,
                   c.conkey[1] as child_attnum,
                   a.attname as child_column,
                   c.confdeltype
              from pg_constraint c
              join pg_attribute a
                on a.attrelid = c.conrelid
               and a.attnum = c.conkey[1]
             where c.contype = 'f'
               and c.confrelid = 'public.raw_messages'::regclass
               and array_length(c.conkey, 1) = 1
               and array_length(c.confkey, 1) = 1
               and c.confdeltype in ('a', 'r')
        loop
            select not a.attnotnull
              into v_nullable
              from pg_attribute a
             where a.attrelid = v_fk.conrelid
               and a.attnum = v_fk.child_attnum;

            if v_nullable then
                execute format(
                    'update %s child set %I = null from _propai_raw_retention_ids doomed where child.%I = doomed.id',
                    v_fk.conrelid::regclass,
                    v_fk.child_column,
                    v_fk.child_column
                );
            else
                execute format(
                    'delete from %s child using _propai_raw_retention_ids doomed where child.%I = doomed.id',
                    v_fk.conrelid::regclass,
                    v_fk.child_column
                );
            end if;
        end loop;

        delete from public.raw_messages r
         using _propai_raw_retention_ids doomed
         where r.id = doomed.id;

        get diagnostics v_batch = row_count;
        v_deleted := v_deleted + v_batch;
        perform pg_sleep(0.05);
    end loop;

    return v_deleted;
end;
$fn$;

revoke all on function public.prune_raw_messages(interval, integer)
  from public, anon, authenticated;
grant execute on function public.prune_raw_messages(interval, integer)
  to service_role;

comment on function public.prune_raw_messages(interval, integer) is
  'Deletes every raw WhatsApp row older than the retention window in bounded batches. Nullable foreign-key references are detached; non-nullable dependent rows and existing cascading typed records are removed.';

-- Reclaim existing space immediately, then continue nightly.
select public.prune_raw_messages(interval '30 days', 2000);

do $cron$
declare
    v_jobid bigint;
begin
    if exists (select 1 from pg_namespace where nspname = 'cron') then
        select jobid into v_jobid
          from cron.job
         where jobname = 'propai-raw-messages-retention';
        if v_jobid is not null then
            perform cron.unschedule(v_jobid);
        end if;
        perform cron.schedule(
            'propai-raw-messages-retention',
            '30 0 * * *',
            $job$select public.prune_raw_messages(interval '30 days', 2000);$job$
        );
    end if;
end;
$cron$;

analyze public.raw_messages;
