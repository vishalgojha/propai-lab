-- WhatsApp Markdown decoration is formatting, not building identity. Enforce
-- this at the database boundary so every writer (workers, API, imports) gets
-- the same canonical value.

create or replace function public.normalize_building_name_formatting()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  cleaned text;
begin
  if tg_table_name = 'buildings' then
    cleaned := regexp_replace(regexp_replace(btrim(coalesce(new.canonical_name, '')), '\s+', ' ', 'g'), '^[*_~`]+|[*_~`]+$', '', 'g');
    new.canonical_name := nullif(btrim(cleaned), '');
  elsif tg_table_name = 'building_name_aliases' then
    cleaned := regexp_replace(regexp_replace(btrim(coalesce(new.alias, '')), '\s+', ' ', 'g'), '^[*_~`]+|[*_~`]+$', '', 'g');
    new.alias := nullif(btrim(cleaned), '');
    cleaned := regexp_replace(regexp_replace(btrim(coalesce(new.canonical_name, '')), '\s+', ' ', 'g'), '^[*_~`]+|[*_~]+$', '', 'g');
    new.canonical_name := nullif(btrim(cleaned), '');
  else
    cleaned := regexp_replace(regexp_replace(btrim(coalesce(new.building_name, '')), '\s+', ' ', 'g'), '^[*_~`]+|[*_~`]+$', '', 'g');
    new.building_name := nullif(btrim(cleaned), '');
  end if;
  return new;
end;
$$;

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
    execute format('drop trigger if exists normalize_building_name_formatting on public.%I', table_name);
    execute format('create trigger normalize_building_name_formatting before insert or update of building_name on public.%I for each row execute function public.normalize_building_name_formatting()', table_name);
  end loop;
end $$;

drop trigger if exists normalize_building_name_formatting on public.buildings;
create trigger normalize_building_name_formatting
before insert or update of canonical_name on public.buildings
for each row execute function public.normalize_building_name_formatting();

drop trigger if exists normalize_building_name_formatting on public.building_name_aliases;
create trigger normalize_building_name_formatting
before insert or update of alias, canonical_name on public.building_name_aliases
for each row execute function public.normalize_building_name_formatting();

-- Targeted historical cleanup: only remove outer Markdown markers and
-- normalize whitespace; do not alter internal punctuation or infer names.
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
      update public.%I
      set building_name = nullif(btrim(regexp_replace(regexp_replace(btrim(building_name), '\s+', ' ', 'g'), '^[*_~`]+|[*_~`]+$', '', 'g')), ''),
          updated_at = now()
      where building_name is not null
        and building_name ~ '(^[*_~`]+|[*_~`]+$)'
    $sql$, table_name);
  end loop;
end $$;

update public.buildings
set canonical_name = nullif(btrim(regexp_replace(regexp_replace(btrim(canonical_name), '\s+', ' ', 'g'), '^[*_~`]+|[*_~`]+$', '', 'g')), ''),
    updated_at = now()
where canonical_name is not null
  and canonical_name ~ '(^[*_~`]+|[*_~`]+$)'
  and not exists (
    select 1
    from public.buildings other
    where other.id <> public.buildings.id
      and coalesce(other.tenant_id, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(public.buildings.tenant_id, '00000000-0000-0000-0000-000000000000'::uuid)
      and lower(btrim(other.canonical_name)) = lower(btrim(regexp_replace(regexp_replace(btrim(public.buildings.canonical_name), '\s+', ' ', 'g'), '^[*_~`]+|[*_~`]+$', '', 'g')))
      and coalesce(other.canonical_micro_market_slug, '') = coalesce(public.buildings.canonical_micro_market_slug, '')
  );

update public.building_name_aliases
set alias = nullif(btrim(regexp_replace(regexp_replace(btrim(alias), '\s+', ' ', 'g'), '^[*_~`]+|[*_~`]+$', '', 'g')), ''),
    canonical_name = nullif(btrim(regexp_replace(regexp_replace(btrim(canonical_name), '\s+', ' ', 'g'), '^[*_~`]+|[*_~`]+$', '', 'g')), '')
where (alias ~ '(^[*_~`]+|[*_~`]+$)'
   or canonical_name ~ '(^[*_~`]+|[*_~`]+$)')
  and not exists (
    select 1 from public.building_name_aliases other
    where other.id <> public.building_name_aliases.id
      and lower(btrim(other.alias)) = lower(btrim(regexp_replace(regexp_replace(btrim(public.building_name_aliases.alias), '\s+', ' ', 'g'), '^[*_~`]+|[*_~`]+$', '', 'g')))
  );

revoke all on function public.normalize_building_name_formatting() from public, anon, authenticated;
grant execute on function public.normalize_building_name_formatting() to service_role;
