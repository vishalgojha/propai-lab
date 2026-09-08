-- Automatic building candidates must be reviewed before any paid provider call.
-- Explicit approval through the admin API is the only path back to pending.

update public.building_enrichment_jobs
   set status = 'needs_review'
 where status = 'pending'
   and attempts = 0
   and provider = 'unassigned';

update public.building_enrichment_jobs
   set status = 'needs_review'
 where status = 'pending'
   and attempts = 0
   and provider = 'google_places'
   and priority <= 20;

create index if not exists building_enrichment_jobs_review_idx
  on public.building_enrichment_jobs (priority desc, created_at, id)
  where status = 'needs_review';

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
    perform pg_advisory_xact_lock(target_id);
    select exists (
      select 1 from public.building_enrichment_jobs j
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
       and j.status not in ('pending', 'running', 'needs_review')
     order by j.id desc limit 1;
    if latest_job_id is not null then
      update public.building_enrichment_jobs
         set status = 'needs_review', priority = greatest(coalesce(priority, 0), 20),
             attempts = 0, last_error = null, scheduled_after = now(),
             started_at = null, completed_at = null
       where id = latest_job_id;
    elsif not exists (
      select 1 from public.building_enrichment_jobs j
       where j.building_id = target_id
         and j.provider = 'google_places'
         and j.status in ('pending', 'running', 'needs_review')
    ) then
      insert into public.building_enrichment_jobs (building_id, provider, priority, status)
      values (target_id, 'google_places', 20, 'needs_review');
    end if;
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

revoke all on function public.requeue_building_enrichment_for_context() from public;
grant execute on function public.requeue_building_enrichment_for_context() to service_role;
