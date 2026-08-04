-- Pairing and extraction are separate user-controlled actions.
alter table public.org_whatsapp_connections
    add column if not exists extraction_status text not null default 'stopped';

alter table public.org_whatsapp_connections
    drop constraint if exists org_whatsapp_connections_extraction_status_check;

alter table public.org_whatsapp_connections
    add constraint org_whatsapp_connections_extraction_status_check
    check (extraction_status in ('stopped', 'running', 'paused'));

-- Pairing and extraction are intentionally separate. Existing connections
-- also start stopped so the user can review opt-outs before resuming ingest.
update public.org_whatsapp_connections
set extraction_status = 'stopped'
where extraction_status <> 'stopped';

create index if not exists idx_org_whatsapp_connections_extraction_status
    on public.org_whatsapp_connections (organization_id, extraction_status);

-- Group opt-out is reversible. Suppressed rows remain available as raw
-- history, but the extraction worker must not consume them while opted out.
alter table public.raw_messages
    add column if not exists extraction_suppressed boolean not null default false;

create index if not exists idx_raw_messages_extraction_queue
    on public.raw_messages (tenant_id, id)
    where processed = false and extraction_suppressed = false;
