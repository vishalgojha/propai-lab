-- Building enrichment is evidence-dependent. Whenever a typed source row is
-- linked, renamed, or receives new locality context, automatically revisit the
-- building instead of relying on an operator to press Refresh All.

create or replace function public.requeue_building_enrichment_for_context()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_id bigint;
  latest_job_id bigint;
begin
  foreach target_id in array array_remove(array[
    case when tg_op = 'DELETE' then old.building_id else new.building_id end,
    case when tg_op = 'UPDATE' then old.building_id else null end
  ], null::bigint) loop
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
    elsif not exists (
      select 1 from public.building_enrichment_jobs j
       where j.building_id = target_id
         and j.provider = 'google_places'
         and j.status in ('pending', 'running')
    ) then
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

do $$ declare table_name text; begin
  foreach table_name in array array[
    'residential_sale_listings', 'residential_rent_listings',
    'commercial_sale_listings', 'commercial_rent_listings'
  ] loop
    execute format(
      'drop trigger if exists trg_requeue_building_context_%I on public.%I',
      table_name, table_name
    );
    execute format(
      'create trigger trg_requeue_building_context_%I
       after insert or update of building_id, building_name, micro_market,
         locality_raw, locality_resolved or delete on public.%I
       for each row execute function public.requeue_building_enrichment_for_context()',
      table_name, table_name
    );
  end loop;
end $$;

drop trigger if exists trg_requeue_building_context_aliases on public.building_name_aliases;
create trigger trg_requeue_building_context_aliases
after insert or update of building_id, alias or delete on public.building_name_aliases
for each row execute function public.requeue_building_enrichment_for_context();

-- Revisit existing source-linked buildings once after deployment so the new
-- source-context gate repairs historical enrichments without manual clicks.
do $$
declare
  building_row record;
  latest_job_id bigint;
begin
  for building_row in
    select distinct l.building_id
      from (
        select building_id from public.residential_sale_listings
        union all select building_id from public.residential_rent_listings
        union all select building_id from public.commercial_sale_listings
        union all select building_id from public.commercial_rent_listings
      ) l
     where l.building_id is not null
  loop
    select j.id into latest_job_id
      from public.building_enrichment_jobs j
     where j.building_id = building_row.building_id
       and j.provider = 'google_places'
       and j.status not in ('pending', 'running')
     order by j.id desc
     limit 1;

    if latest_job_id is not null then
      update public.building_enrichment_jobs
         set status = 'pending', priority = greatest(coalesce(priority, 0), 20),
             attempts = 0, last_error = null, scheduled_after = now(),
             started_at = null, completed_at = null
       where id = latest_job_id;
    elsif not exists (
      select 1 from public.building_enrichment_jobs j
       where j.building_id = building_row.building_id
         and j.provider = 'google_places'
         and j.status in ('pending', 'running')
    ) then
      insert into public.building_enrichment_jobs (building_id, provider, priority, status)
      values (building_row.building_id, 'google_places', 20, 'pending');
    end if;
  end loop;
end $$;
