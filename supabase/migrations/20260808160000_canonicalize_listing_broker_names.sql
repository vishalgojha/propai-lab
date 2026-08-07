-- Listing broker_name is a display field. Once broker_id is known, always
-- render the canonical broker identity instead of copied WhatsApp prose.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'residential_sale_listings', 'residential_rent_listings',
    'commercial_sale_listings', 'commercial_rent_listings'
  ] loop
    execute format($sql$
      update %I l
         set broker_name = nullif(btrim(b.canonical_name), '')
        from brokers b
       where l.broker_id = b.id
         and nullif(btrim(b.canonical_name), '') is not null
         and l.broker_name is distinct from b.canonical_name
    $sql$, table_name);
  end loop;
end $$;
