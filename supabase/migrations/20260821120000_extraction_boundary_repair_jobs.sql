-- Idempotent repair queue for historical WhatsApp broadcasts that were sent
-- to extraction as one parent instead of deterministic child slices.
alter table public.raw_messages
  add column if not exists extraction_superseded boolean not null default false;

create table if not exists public.extraction_repair_jobs (
  id bigint generated always as identity primary key,
  tenant_id uuid references public.organizations(id),
  parent_raw_id bigint not null references public.raw_messages(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued','running','completed','no_split','failed')),
  pattern_id text,
  child_raw_ids bigint[] not null default '{}',
  existing_parsed_count integer not null default 0,
  error text,
  requested_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (parent_raw_id)
);

create index if not exists idx_extraction_repair_jobs_status
  on public.extraction_repair_jobs(status, created_at desc);
create index if not exists idx_raw_messages_repair_parent
  on public.raw_messages(extraction_superseded, parent_message_id, processed);

-- Public typed projections must not expose the stale parent observation after
-- its child slices have been queued. The immutable parent remains queryable as
-- raw evidence and the new child rows become the only extraction inputs.
drop view if exists public.parsed_output_unified;
create view public.parsed_output_unified as
select 'residential_sale' card_type,l.id,l.raw_message_id,l.tenant_id,l.building_name,l.micro_market,l.broker_name,l.broker_phone,l.bhk::text bhk,l.carpet_area_sqft area_sqft,l.total_asking_price price,'sale' transaction_type,l.needs_review,l.created_at
from public.residential_sale_listings l join public.raw_messages rm on rm.id=l.raw_message_id where not coalesce(rm.extraction_superseded,false)
union all select 'residential_rent',l.id,l.raw_message_id,l.tenant_id,l.building_name,l.micro_market,l.broker_name,l.broker_phone,l.bhk::text,l.carpet_area_sqft,l.monthly_rent,'rent',l.needs_review,l.created_at
from public.residential_rent_listings l join public.raw_messages rm on rm.id=l.raw_message_id where not coalesce(rm.extraction_superseded,false)
union all select 'commercial_sale',l.id,l.raw_message_id,l.tenant_id,l.building_name,l.micro_market,l.broker_name,l.broker_phone,null,l.carpet_area_sqft,l.total_asking_price,'sale',l.needs_review,l.created_at
from public.commercial_sale_listings l join public.raw_messages rm on rm.id=l.raw_message_id where not coalesce(rm.extraction_superseded,false)
union all select 'commercial_rent',l.id,l.raw_message_id,l.tenant_id,l.building_name,l.micro_market,l.broker_name,l.broker_phone,null,l.carpet_area_sqft,l.monthly_rent,'rent',l.needs_review,l.created_at
from public.commercial_rent_listings l join public.raw_messages rm on rm.id=l.raw_message_id where not coalesce(rm.extraction_superseded,false);

notify pgrst, 'reload schema';
