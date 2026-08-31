-- Prevent concurrent locality/listing updates from creating duplicate active
-- Google Places jobs for the same building. The active-job unique index is a
-- correctness invariant; requeue decisions must be serialized with it.

create or replace function public.requeue_building_enrichment_for_context()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_id bigint;
  latest_job_id bigint;
  active_job_exists boolean;
begin
  foreach target_id in array array_remove(array[
    case when tg_op = 'DELETE' then old.building_id else new.building_id end,
    case when tg_op = 'UPDATE' then old.building_id else null end
  ], null::bigint) loop
    -- A transaction-scoped advisory lock makes the active-job check and the
    -- requeue/insert one indivisible decision for this building.
    perform pg_advisory_xact_lock(target_id);

    select exists (
      select 1
        from public.building_enrichment_jobs j
       where j.building_id = target_id
         and j.provider = 'google_places'
         and j.status in ('pending', 'running')
    ) into active_job_exists;

    if active_job_exists then
      continue;
    end if;

    select j.id into latest_job_id
      from public.building_enrichment_jobs j
     where j.building_id = target_id
       and j.provider = 'google_places'
       and j.status not in ('pending', 'running')
     order by j.id desc
     limit 1;

    if latest_job_id is not null then
      update public.building_enrichment_jobs
         set status = 'pending',
             priority = greatest(coalesce(priority, 0), 20),
             attempts = 0,
             last_error = null,
             scheduled_after = now(),
             started_at = null,
             completed_at = null
       where id = latest_job_id;
    else
      insert into public.building_enrichment_jobs
        (building_id, provider, priority, status)
      values (target_id, 'google_places', 20, 'pending');
    end if;
  end loop;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
