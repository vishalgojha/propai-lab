-- Data-quality invariants for broker identity and building resolution.

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'residential_rent_listings',
    'residential_sale_listings',
    'commercial_rent_listings',
    'commercial_sale_listings'
  ] loop
    execute format($sql$
      update public.%I
         set broker_name = null
       where broker_name is not null
         and btrim(broker_name) ~ '^[+0-9 ()-]{7,15}$'
         and btrim(broker_name) ~ '[0-9]'
    $sql$, table_name);

    execute format($sql$
      alter table public.%I
        drop constraint if exists %I
    $sql$, table_name, table_name || '_broker_name_not_phone');

    execute format($sql$
      alter table public.%I
        add constraint %I check (
          broker_name is null
          or not (
            btrim(broker_name) ~ '^[+0-9 ()-]{7,15}$'
            and btrim(broker_name) ~ '[0-9]'
          )
        )
    $sql$, table_name, table_name || '_broker_name_not_phone');
  end loop;
end $$;

do $$
declare
  table_name text;
begin
  -- This record is the locality-qualified Mahalaxmi building. Keep its
  -- location explicit so both enrichment and map resolution use the right
  -- record instead of the shorter duplicate.
  update public.buildings
     set micro_market = coalesce(nullif(btrim(micro_market), ''), 'Mahalaxmi'),
         updated_at = now()
   where id = 10492;

  foreach table_name in array array[
    'residential_rent_listings',
    'residential_sale_listings',
    'commercial_rent_listings',
    'commercial_sale_listings'
  ] loop
    execute format($sql$
      update public.%I
         set building_name = 'Lokhandwala Minerva Mahalaxmi'
       where lower(btrim(building_name)) = 'lokhandwala minerva'
         and lower(coalesce(micro_market, '')) like '%%mahalaxmi%%'
    $sql$, table_name);
  end loop;

  insert into public.building_name_aliases
    (building_id, alias, canonical_name, confidence, source)
  select 10492, 'Lokhandwala Minerva Mahalaxmi',
         'Lokhandwala Minerva Mahalaxmi', 1.0, 'data_quality_alias'
   where not exists (
     select 1 from public.building_name_aliases
      where lower(alias) = lower('Lokhandwala Minerva Mahalaxmi')
        and building_id = 10492
   );

  -- Let the existing Google Places worker geocode this exact record. We do
  -- not invent coordinates in SQL when the provider has not verified them.
  update public.building_enrichment_jobs
     set provider = 'google_places', priority = greatest(priority, 100),
         status = 'pending', last_error = null, scheduled_after = now()
   where building_id = 10492
     and status in ('pending', 'failed');
end $$;
