-- Approval-first broker follow-up workflow for tenant-private inbound leads.
-- This stores drafts and outcomes only; it never creates market inventory.
create table if not exists public.inbound_lead_followups (
    id bigint generated always as identity primary key,
    tenant_id uuid not null references public.organizations(id) on delete cascade,
    lead_id bigint not null references public.inbound_leads(id) on delete cascade,
    listing_id bigint,
    draft_text text not null,
    status text not null default 'drafted' check (status in ('drafted', 'opened', 'completed', 'snoozed', 'dismissed')),
    outcome text,
    created_by uuid,
    completed_by uuid,
    created_at timestamptz not null default now(),
    opened_at timestamptz,
    completed_at timestamptz,
    updated_at timestamptz not null default now(),
    unique (tenant_id, lead_id)
);

create index if not exists idx_inbound_lead_followups_tenant_status
    on public.inbound_lead_followups (tenant_id, status, updated_at desc);

alter table public.inbound_lead_followups enable row level security;
drop policy if exists inbound_lead_followups_service_role_all on public.inbound_lead_followups;
create policy inbound_lead_followups_service_role_all on public.inbound_lead_followups
    for all to service_role using (true) with check (true);

drop trigger if exists set_inbound_lead_followups_updated_at on public.inbound_lead_followups;
create trigger set_inbound_lead_followups_updated_at before update on public.inbound_lead_followups
    for each row execute function public.trigger_market_requirements_updated_at();

alter table public.inbound_leads drop constraint if exists inbound_leads_status_check;
alter table public.inbound_leads add constraint inbound_leads_status_check
    check (status in ('received', 'matched', 'duplicate', 'failed', 'needs_followup', 'contacted', 'closed', 'snoozed'));
