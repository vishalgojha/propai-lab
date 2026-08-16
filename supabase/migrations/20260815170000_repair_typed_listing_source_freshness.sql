-- Freshness must follow the WhatsApp message timestamp, not the time an old
-- queued message happened to be extracted.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'residential_sale_listings',
    'residential_rent_listings',
    'commercial_sale_listings',
    'commercial_rent_listings',
    'residential_sale_requirements',
    'residential_rent_requirements',
    'commercial_sale_requirements',
    'commercial_rent_requirements'
  ] loop
    execute format(
      'update public.%I t
       set last_seen_at = r.timestamp,
           expires_at = r.timestamp + interval ''30 days''
       from public.raw_messages r
       where t.raw_message_id = r.id
         and t.tenant_id = r.tenant_id
         and r.timestamp is not null',
      table_name
    );
  end loop;
end $$;
