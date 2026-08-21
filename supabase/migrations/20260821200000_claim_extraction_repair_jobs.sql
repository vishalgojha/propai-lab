create or replace function public.claim_extraction_repair_jobs(p_limit integer default 2)
returns setof public.extraction_repair_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with picked as (
    select id
    from public.extraction_repair_jobs
    where status = 'queued'
    order by created_at, id
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 2), 10))
  )
  update public.extraction_repair_jobs j
     set status = 'running', updated_at = now(), error = null
    from picked
   where j.id = picked.id
  returning j.*;
end;
$$;

revoke all on function public.claim_extraction_repair_jobs(integer) from public;
grant execute on function public.claim_extraction_repair_jobs(integer) to service_role;
