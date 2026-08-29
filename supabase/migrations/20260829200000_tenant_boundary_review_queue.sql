-- Controlled review queue for historical typed/raw tenant mismatches.
-- This records evidence only; it does not reassign or delete data.

create table if not exists public.tenant_boundary_review_queue (
  id bigint generated always as identity primary key,
  typed_table text not null,
  typed_row_id bigint not null,
  raw_message_id bigint not null references public.raw_messages(id) on delete cascade,
  typed_tenant_id uuid references public.organizations(id),
  raw_tenant_id uuid references public.organizations(id),
  group_jid text,
  message_uid text,
  raw_source text,
  raw_processed boolean,
  extraction_suppressed boolean,
  decision text not null default 'pending' check (decision in ('pending', 'replay', 'quarantine', 'repaired', 'rejected')),
  decision_reason text,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (typed_table, typed_row_id)
);

create index if not exists idx_tenant_boundary_review_queue_decision
  on public.tenant_boundary_review_queue(decision, created_at desc);
create index if not exists idx_tenant_boundary_review_queue_raw
  on public.tenant_boundary_review_queue(raw_message_id);

alter table public.tenant_boundary_review_queue enable row level security;
revoke all on public.tenant_boundary_review_queue from public, anon, authenticated;
grant select, insert, update on public.tenant_boundary_review_queue to service_role;

insert into public.tenant_boundary_review_queue (
  typed_table, typed_row_id, raw_message_id, typed_tenant_id, raw_tenant_id,
  group_jid, message_uid, raw_source, raw_processed, extraction_suppressed
)
select 'residential_sale_requirements', r.id, r.raw_message_id, r.tenant_id,
       rm.tenant_id, rm.group_name, rm.message_uid, rm.source, rm.processed,
       rm.extraction_suppressed
from public.residential_sale_requirements r
join public.raw_messages rm on rm.id = r.raw_message_id
where r.tenant_id is distinct from rm.tenant_id
union all
select 'residential_rent_requirements', r.id, r.raw_message_id, r.tenant_id,
       rm.tenant_id, rm.group_name, rm.message_uid, rm.source, rm.processed,
       rm.extraction_suppressed
from public.residential_rent_requirements r
join public.raw_messages rm on rm.id = r.raw_message_id
where r.tenant_id is distinct from rm.tenant_id
union all
select 'commercial_sale_requirements', r.id, r.raw_message_id, r.tenant_id,
       rm.tenant_id, rm.group_name, rm.message_uid, rm.source, rm.processed,
       rm.extraction_suppressed
from public.commercial_sale_requirements r
join public.raw_messages rm on rm.id = r.raw_message_id
where r.tenant_id is distinct from rm.tenant_id
union all
select 'commercial_rent_requirements', r.id, r.raw_message_id, r.tenant_id,
       rm.tenant_id, rm.group_name, rm.message_uid, rm.source, rm.processed,
       rm.extraction_suppressed
from public.commercial_rent_requirements r
join public.raw_messages rm on rm.id = r.raw_message_id
where r.tenant_id is distinct from rm.tenant_id
on conflict (typed_table, typed_row_id) do nothing;
