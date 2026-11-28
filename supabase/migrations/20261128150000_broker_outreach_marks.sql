-- Additive only: personal "who I have messaged" marks for manual broker outreach.
-- Touches no existing table or broker record. Not linked to any consent or capture.
begin;
set local lock_timeout='2s';
set local statement_timeout='10s';
create table if not exists public.broker_outreach_marks (
 organization_id uuid not null,
 broker_key text not null check (broker_key ~ '^(bare:[0-9]{10}|intl:[0-9]{11,15})$'),
 status text not null check (status in ('sent','replied','skipped')),
 marked_by uuid,
 marked_at timestamptz not null default now(),
 primary key (organization_id, broker_key)
);
alter table public.broker_outreach_marks enable row level security;
revoke all on public.broker_outreach_marks from public,anon,authenticated;
grant select,insert,update,delete on public.broker_outreach_marks to service_role;
commit;
