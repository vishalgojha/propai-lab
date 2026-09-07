-- Preserve explicit broker-operational notes that do not yet have a typed
-- property column. This is internal evidence; public projections must not
-- expose it as a substitute for source-safe listing fields.
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
      'alter table public.%I add column if not exists broker_notes jsonb not null default ''[]''::jsonb',
      table_name
    );
    execute format(
      'comment on column public.%I.broker_notes is %L',
      table_name,
      'Source-grounded broker notes not represented by a typed field. Each item has category, text, and source_text. Internal evidence only.'
    );
  end loop;
end $$;

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
    execute format('alter table public.%I drop constraint if exists %I', table_name, table_name || '_broker_notes_array');
    execute format(
      'alter table public.%I add constraint %I check (jsonb_typeof(broker_notes) = ''array'')',
      table_name,
      table_name || '_broker_notes_array'
    );
  end loop;
end $$;
