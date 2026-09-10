-- Restore the exact partial unique indexes required by the WhatsMeow
-- ingestor's ON CONFLICT (tenant_id, message_uid) WHERE source predicate.
-- The old global index both caused the conflict-target error and incorrectly
-- made a message UID from one tenant suppress the same UID in another.

drop index if exists public.idx_raw_messages_message_uid_unique;
drop index if exists public.idx_raw_messages_waba_inbound_uid_unique;
drop index if exists public.idx_raw_messages_waba_tenant_uid_unique;
drop index if exists public.idx_raw_messages_whatsapp_tenant_uid_unique;

create unique index idx_raw_messages_waba_tenant_uid_unique
    on public.raw_messages (tenant_id, message_uid)
    where source = 'WABA_INBOUND';

create unique index idx_raw_messages_whatsapp_tenant_uid_unique
    on public.raw_messages (tenant_id, message_uid)
    where source = 'WHATSAPP';
