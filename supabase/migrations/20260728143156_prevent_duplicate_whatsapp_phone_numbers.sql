-- The exact-value constraint does not catch formatting variants such as
-- "+91 97737 57759" versus "919773757759". Pairing placeholders are excluded
-- until WhatsApp reports a real number.
create unique index if not exists uq_org_whatsapp_connections_normalized_phone
on public.org_whatsapp_connections (
  organization_id,
  right(regexp_replace(phone_number, '\D', '', 'g'), 10)
)
where phone_number is not null
  and phone_number not like 'Unpaired:%'
  and length(regexp_replace(phone_number, '\D', '', 'g')) >= 10;
