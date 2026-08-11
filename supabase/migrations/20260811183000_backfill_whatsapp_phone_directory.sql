-- Preserve WhatsApp numbers created before the profile phone directory became
-- the source of truth. The insert is idempotent and respects the three-number
-- workspace cap enforced by trg_org_whatsapp_phone_directory_cap.
with missing_connections as (
    select
        connection.*,
        (
            select count(*)
            from public.org_whatsapp_phone_directory as existing_count
            where existing_count.organization_id = connection.organization_id
        ) as existing_directory_count,
        row_number() over (
            partition by connection.organization_id
            order by connection.created_at, connection.id
        ) as missing_rank
    from public.org_whatsapp_connections as connection
    where nullif(trim(connection.broker_id), '') is not null
      and nullif(trim(connection.phone_number), '') is not null
      and connection.phone_number not ilike 'Unpaired:%'
      and length(regexp_replace(connection.phone_number, '\D', '', 'g')) between 10 and 15
      and not exists (
          select 1
          from public.org_whatsapp_phone_directory as existing
          where existing.organization_id = connection.organization_id
            and (
                existing.broker_id = connection.broker_id
                or right(regexp_replace(existing.phone_number, '\D', '', 'g'), 10)
                   = right(regexp_replace(connection.phone_number, '\D', '', 'g'), 10)
            )
      )
)
insert into public.org_whatsapp_phone_directory (
    organization_id,
    broker_id,
    phone_number,
    display_label,
    is_active,
    created_at,
    updated_at
)
select
    missing.organization_id,
    missing.broker_id,
    missing.phone_number,
    coalesce(missing.instance_name, ''),
    missing.is_active,
    missing.created_at,
    missing.updated_at
from missing_connections as missing
where missing.missing_rank <= greatest(0, 3 - missing.existing_directory_count)
on conflict do nothing;
