-- broker_id is the authoritative identity. Historical typed rows may still
-- contain a WhatsApp push name or extracted alias; normalize display data to
-- the canonical broker profile without changing source evidence.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'residential_sale_listings', 'residential_rent_listings',
    'commercial_sale_listings', 'commercial_rent_listings',
    'residential_sale_requirements', 'residential_rent_requirements',
    'commercial_sale_requirements', 'commercial_rent_requirements'
  ] loop
    execute format($sql$
      update public.%I as typed
      set broker_name = brokers.canonical_name,
          updated_at = now()
      from public.brokers
      where typed.broker_id = brokers.id
        and nullif(btrim(brokers.canonical_name), '') is not null
        and typed.broker_name is distinct from brokers.canonical_name
    $sql$, table_name);
  end loop;
end
$$;

comment on column public.brokers.canonical_name is
  'Authoritative broker display name; source signatures and WhatsApp push names remain evidence/aliases.';
