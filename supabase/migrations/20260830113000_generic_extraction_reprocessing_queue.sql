-- Durable, idempotent queue for source-grounded reprocessing of typed rows.
-- The worker owns the extraction/LLM decision; this migration only identifies
-- conservative locality candidates and records queue state.

create table if not exists public.extraction_reprocessing_jobs (
  id bigint generated always as identity primary key,
  tenant_id uuid references public.organizations(id),
  source_table text not null check (source_table in (
    'residential_sale_listings', 'residential_rent_listings',
    'commercial_sale_listings', 'commercial_rent_listings',
    'residential_sale_requirements', 'residential_rent_requirements',
    'commercial_sale_requirements', 'commercial_rent_requirements'
  )),
  source_row_id bigint not null,
  -- Legacy typed rows can retain an audit-only raw ID after the source row has
  -- been deleted. Do not make those rows prevent queue creation; the worker
  -- classifies them as no_source terminal outcomes.
  raw_message_id bigint,
  status text not null default 'queued' check (status in (
    'queued', 'running', 'fixed', 'still_unresolved', 'no_source', 'failed'
  )),
  attempt_count integer not null default 0,
  last_error text,
  result jsonb not null default '{}'::jsonb,
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_table, source_row_id)
);

create index if not exists idx_extraction_reprocessing_jobs_claim
  on public.extraction_reprocessing_jobs(status, updated_at, id)
  where status = 'queued';
create index if not exists idx_extraction_reprocessing_jobs_raw
  on public.extraction_reprocessing_jobs(raw_message_id, status);

create table if not exists public.extraction_reprocessing_runs (
  id bigint generated always as identity primary key,
  worker_name text not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  counts jsonb not null default '{}'::jsonb,
  config jsonb not null default '{}'::jsonb,
  error text
);

alter table public.extraction_reprocessing_jobs enable row level security;
alter table public.extraction_reprocessing_runs enable row level security;
revoke all on table public.extraction_reprocessing_jobs from anon, authenticated;
revoke all on table public.extraction_reprocessing_runs from anon, authenticated;
grant select, insert, update on table public.extraction_reprocessing_jobs to service_role;
grant select, insert, update on table public.extraction_reprocessing_runs to service_role;

-- A locality candidate is queued only when the source is recoverable and an
-- exact canonical locality/alias appears in that source. This is the
-- conservative source-present portion of the audit's approximately 28%
-- plausibly fixable sample; no locality is assigned by this statement.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'residential_sale_listings', 'residential_rent_listings',
    'commercial_sale_listings', 'commercial_rent_listings',
    'residential_sale_requirements', 'residential_rent_requirements',
    'commercial_sale_requirements', 'commercial_rent_requirements'
  ] loop
    execute format($sql$
      with candidates as (
        select t.id,
               lower(coalesce(
                 nullif(t.raw_payload->>'slice_text', ''),
                 nullif(t.raw_payload->>'full_text', ''),
                 nullif(t.normalized_message, ''),
                 r.message,
                 ''
               )) as source_text
          from public.%1$I t
          left join public.raw_messages r on r.id = t.raw_message_id
         where t.needs_review = true
           and nullif(btrim(coalesce(t.locality_raw, '')), '') is null
           and nullif(btrim(coalesce(t.locality_resolved, '')), '') is null
           and nullif(btrim(coalesce(t.micro_market, '')), '') is null
           and nullif(btrim(coalesce(t.raw_payload->>'slice_text', '')), '') is not null
      ), locality_hits as (
        select distinct c.id
          from candidates c
          join public.locality_reference lr on
            position(lower(btrim(lr.sub_locality)) in c.source_text) > 0
            or exists (
              select 1 from unnest(coalesce(lr.alternate_names, array[]::text[])) a(name)
               where nullif(btrim(a.name), '') is not null
                 and position(lower(btrim(a.name)) in c.source_text) > 0
            )
         where nullif(btrim(lr.sub_locality), '') is not null
      )
      update public.%1$I t
         set validation_flags = (
               select jsonb_agg(flag order by flag)
                 from (
                   select value as flag
                     from jsonb_array_elements_text(
                       case when jsonb_typeof(coalesce(t.validation_flags, '[]'::jsonb)) = 'array'
                            then coalesce(t.validation_flags, '[]'::jsonb)
                            else '[]'::jsonb end
                     )
                   union
                   select 'locality_unresolved'::text
                 ) flags
             ),
             updated_at = now()
        from locality_hits h
       where t.id = h.id
         and not (coalesce(t.validation_flags, '[]'::jsonb) @> '["locality_unresolved"]'::jsonb)
    $sql$, table_name);
  end loop;
end $$;

-- Seed every review row, including rows with no source. The worker marks the
-- latter terminally as no_source instead of retrying them forever.
insert into public.extraction_reprocessing_jobs (
  tenant_id, source_table, source_row_id, raw_message_id, status
)
select tenant_id, 'residential_sale_listings', id, raw_message_id, 'queued'
  from public.residential_sale_listings where needs_review = true
union all select tenant_id, 'residential_rent_listings', id, raw_message_id, 'queued'
  from public.residential_rent_listings where needs_review = true
union all select tenant_id, 'commercial_sale_listings', id, raw_message_id, 'queued'
  from public.commercial_sale_listings where needs_review = true
union all select tenant_id, 'commercial_rent_listings', id, raw_message_id, 'queued'
  from public.commercial_rent_listings where needs_review = true
union all select tenant_id, 'residential_sale_requirements', id, raw_message_id, 'queued'
  from public.residential_sale_requirements where needs_review = true
union all select tenant_id, 'residential_rent_requirements', id, raw_message_id, 'queued'
  from public.residential_rent_requirements where needs_review = true
union all select tenant_id, 'commercial_sale_requirements', id, raw_message_id, 'queued'
  from public.commercial_sale_requirements where needs_review = true
union all select tenant_id, 'commercial_rent_requirements', id, raw_message_id, 'queued'
  from public.commercial_rent_requirements where needs_review = true
on conflict (source_table, source_row_id) do nothing;

create or replace function public.claim_extraction_reprocessing_jobs(p_limit integer default 10)
returns setof public.extraction_reprocessing_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with picked as (
    select id
      from public.extraction_reprocessing_jobs
     where status = 'queued'
     order by updated_at, id
     for update skip locked
     limit greatest(1, least(coalesce(p_limit, 10), 100))
  )
  update public.extraction_reprocessing_jobs j
     set status = 'running',
         attempt_count = j.attempt_count + 1,
         claimed_at = now(),
         updated_at = now(),
         last_error = null
    from picked
   where j.id = picked.id
  returning j.*;
end;
$$;

revoke all on function public.claim_extraction_reprocessing_jobs(integer) from public;
grant execute on function public.claim_extraction_reprocessing_jobs(integer) to service_role;

notify pgrst, 'reload schema';
