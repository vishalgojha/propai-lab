-- Durable extraction outcomes and bounded building-enrichment queue semantics.

alter table public.raw_messages
  add column if not exists extraction_attempts integer not null default 0,
  add column if not exists extraction_last_error text,
  add column if not exists extraction_outcome text;

create table if not exists public.extraction_attempt_log (
  id bigint generated always as identity primary key,
  raw_message_id bigint not null references public.raw_messages(id) on delete cascade,
  tenant_id uuid,
  lane text,
  attempt_number integer not null,
  status text not null check (status in ('running', 'succeeded', 'skipped', 'failed', 'dead_lettered')),
  reason text,
  details jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_extraction_attempt_log_raw
  on public.extraction_attempt_log(raw_message_id, attempt_number desc);
create index if not exists idx_extraction_attempt_log_status_created
  on public.extraction_attempt_log(status, started_at desc);

alter table public.extraction_attempt_log enable row level security;
revoke all on table public.extraction_attempt_log from anon, authenticated;
grant select, insert, update on table public.extraction_attempt_log to service_role;
grant usage, select on sequence public.extraction_attempt_log_id_seq to service_role;

create or replace function public.begin_extraction_attempt(
  p_raw_message_id bigint,
  p_lane text default ''
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_attempt integer;
  v_tenant uuid;
  v_id bigint;
begin
  update public.raw_messages
     set extraction_attempts = extraction_attempts + 1,
         extraction_outcome = 'running',
         extraction_last_error = null
   where id = p_raw_message_id and processed = false
   returning extraction_attempts, tenant_id into v_attempt, v_tenant;
  if not found then
    raise exception 'raw message % is not available for extraction', p_raw_message_id;
  end if;

  insert into public.extraction_attempt_log(
    raw_message_id, tenant_id, lane, attempt_number, status
  ) values (
    p_raw_message_id, v_tenant, nullif(left(p_lane, 20), ''), v_attempt, 'running'
  ) returning id into v_id;

  return jsonb_build_object('attempt_id', v_id, 'attempt_number', v_attempt);
end;
$$;

create or replace function public.finish_extraction_attempt(
  p_attempt_id bigint,
  p_status text,
  p_reason text default '',
  p_details jsonb default '{}'::jsonb
) returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_raw_id bigint;
begin
  if p_status not in ('succeeded', 'skipped', 'failed') then
    raise exception 'invalid extraction outcome %', p_status;
  end if;
  update public.extraction_attempt_log
     set status = p_status,
         reason = nullif(left(p_reason, 500), ''),
         details = coalesce(p_details, '{}'::jsonb),
         completed_at = now()
   where id = p_attempt_id and status = 'running'
   returning raw_message_id into v_raw_id;
  if not found then return false; end if;

  update public.raw_messages
     set extraction_outcome = p_status,
         extraction_last_error = case when p_status = 'failed' then nullif(left(p_reason, 500), '') else null end
   where id = v_raw_id;
  return true;
end;
$$;

create or replace function public.dead_letter_extraction(
  p_raw_message_id bigint,
  p_reason text,
  p_lane text default ''
) returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_tenant uuid;
  v_attempt integer;
begin
  update public.raw_messages
     set processed = true,
         processed_at = now(),
         extraction_outcome = 'dead_lettered',
         extraction_last_error = nullif(left(p_reason, 500), '')
   where id = p_raw_message_id and processed = false
   returning tenant_id, extraction_attempts into v_tenant, v_attempt;
  if not found then return false; end if;

  insert into public.extraction_attempt_log(
    raw_message_id, tenant_id, lane, attempt_number, status, reason, completed_at
  ) values (
    p_raw_message_id, v_tenant, nullif(left(p_lane, 20), ''), v_attempt,
    'dead_lettered', nullif(left(p_reason, 500), ''), now()
  );
  return true;
end;
$$;

revoke all on function public.begin_extraction_attempt(bigint, text) from public, anon, authenticated;
revoke all on function public.finish_extraction_attempt(bigint, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.dead_letter_extraction(bigint, text, text) from public, anon, authenticated;
grant execute on function public.begin_extraction_attempt(bigint, text) to service_role;
grant execute on function public.finish_extraction_attempt(bigint, text, text, jsonb) to service_role;
grant execute on function public.dead_letter_extraction(bigint, text, text) to service_role;

-- Resolve any pre-existing duplicate active claims before enforcing the queue invariant.
with ranked as (
  select id, row_number() over (
    partition by building_id, provider order by priority desc, id desc
  ) as position
  from public.building_enrichment_jobs
  where status in ('pending', 'running')
)
update public.building_enrichment_jobs j
   set status = 'failed',
       last_error = 'Superseded duplicate active enrichment job',
       completed_at = now()
  from ranked r
 where r.id = j.id and r.position > 1;

create unique index if not exists idx_building_enrichment_one_active
  on public.building_enrichment_jobs(building_id, provider)
  where status in ('pending', 'running');

create index if not exists idx_building_enrichment_runnable
  on public.building_enrichment_jobs(status, scheduled_after, priority desc, id)
  where status = 'pending';
