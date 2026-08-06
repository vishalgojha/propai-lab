-- Agent CRM links and workspace scoping.
-- Existing tenant populations were checked before authoring this migration:
-- clients: 0/1 tenant_id populated; client_requirements: 0/1 populated;
-- leads: 0 rows; internal_notes: 0 rows.

alter table public.leads
  add column if not exists tenant_id uuid,
  add column if not exists client_id bigint;

alter table public.leads
  add constraint leads_client_id_fkey
  foreign key (client_id) references public.clients(id)
  not valid;

update public.leads as l
set tenant_id = b.tenant_id
from public.brokers as b
where l.tenant_id is null
  and l.broker_id is not null
  and b.id = l.broker_id
  and b.tenant_id is not null;

create index if not exists idx_leads_tenant_id
  on public.leads (tenant_id);

alter table public.internal_notes
  add column if not exists tenant_id uuid;

update public.internal_notes as n
set tenant_id = c.tenant_id
from public.clients as c
where n.tenant_id is null
  and lower(n.entity_type) = 'client'
  and n.entity_id ~ '^[0-9]+$'
  and c.id = n.entity_id::bigint
  and c.tenant_id is not null;

with listing_candidates as (
  select id as listing_id, legacy_source_id, tenant_id from public.residential_rent_listings
  union all
  select id, legacy_source_id, tenant_id from public.residential_sale_listings
  union all
  select id, legacy_source_id, tenant_id from public.commercial_rent_listings
  union all
  select id, legacy_source_id, tenant_id from public.commercial_sale_listings
),
resolved as (
  select n.id as note_id,
         (array_agg(distinct c.tenant_id order by c.tenant_id))[1] as tenant_id
  from public.internal_notes as n
  join listing_candidates as c
   on lower(n.entity_type) in ('listing', 'property')
   and n.entity_id ~ '^[0-9]+$'
   and (c.listing_id = n.entity_id::bigint or c.legacy_source_id = n.entity_id::bigint)
  where n.tenant_id is null
  group by n.id
  having count(distinct c.tenant_id) = 1
)
update public.internal_notes as n
set tenant_id = r.tenant_id
from resolved as r
where n.id = r.note_id;

create index if not exists idx_internal_notes_tenant_id
  on public.internal_notes (tenant_id);

alter table public.leads validate constraint leads_client_id_fkey;
