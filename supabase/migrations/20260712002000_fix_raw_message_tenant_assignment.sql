-- Ensure live WhatsApp webhook rows appear in the tenant-scoped inbox.
-- Recent Baileys/whatsmeow payloads often have @lid senders and store the
-- instance under raw_payload.data.instance, so the older trigger could leave
-- raw_messages.tenant_id null.

create or replace function auto_assign_tenant_raw_message()
returns trigger
language plpgsql
as $$
declare
    v_org_id uuid;
    v_instance text;
begin
    if NEW.tenant_id is not null then
        return NEW;
    end if;

    v_instance := coalesce(
        NEW.raw_payload->>'instance',
        NEW.raw_payload #>> '{data,instance}'
    );

    select organization_id into v_org_id
    from org_whatsapp_connections
    where (NEW.sender_phone is not null and NEW.sender_phone <> '' and phone_number = NEW.sender_phone)
       or (v_instance is not null and v_instance <> '' and instance_name = v_instance)
    limit 1;

    if v_org_id is null and exists (
        select 1 from organizations where id = '00000000-0000-0000-0000-000000000010'::uuid
    ) then
        v_org_id := '00000000-0000-0000-0000-000000000010'::uuid;
    end if;

    if v_org_id is not null then
        NEW.tenant_id = v_org_id;
    end if;

    return NEW;
end;
$$;

update raw_messages
set tenant_id = '00000000-0000-0000-0000-000000000010'::uuid
where tenant_id is null
  and source = 'WHATSAPP'
  and exists (
      select 1 from organizations where id = '00000000-0000-0000-0000-000000000010'::uuid
  );
