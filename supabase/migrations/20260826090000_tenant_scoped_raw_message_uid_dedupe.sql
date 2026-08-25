-- Raw message identity is scoped to the owning organization. A message UID
-- from one WhatsApp connection must never suppress the same UID in another
-- tenant, while retries within one source/tenant remain idempotent.

drop index if exists public.idx_raw_messages_waba_inbound_uid_unique;

create unique index if not exists idx_raw_messages_waba_tenant_uid_unique
    on public.raw_messages (tenant_id, message_uid)
    where source = 'WABA_INBOUND'
      and message_uid is not null
      and tenant_id is not null;

create unique index if not exists idx_raw_messages_whatsapp_tenant_uid_unique
    on public.raw_messages (tenant_id, message_uid)
    where source = 'WHATSAPP'
      and message_uid is not null
      and tenant_id is not null;
