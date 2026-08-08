-- The previous building-counter trigger recomputed every building from all
-- four listing tables on every listing INSERT. That made normal extraction
-- writes O(buildings * listings) and caused Postgres statement timeouts.
-- Refresh only buildings affected by the current row instead.

create index if not exists idx_res_sale_building_name_norm
  on public.residential_sale_listings ((lower(trim(building_name))))
  where building_name is not null;
create index if not exists idx_res_rent_building_name_norm
  on public.residential_rent_listings ((lower(trim(building_name))))
  where building_name is not null;
create index if not exists idx_com_sale_building_name_norm
  on public.commercial_sale_listings ((lower(trim(building_name))))
  where building_name is not null;
create index if not exists idx_com_rent_building_name_norm
  on public.commercial_rent_listings ((lower(trim(building_name))))
  where building_name is not null;
create index if not exists idx_building_alias_norm
  on public.building_name_aliases ((lower(trim(alias))));

create or replace function public.refresh_building_observed_listings_for_name(p_name text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized text := lower(trim(nullif(p_name, '')));
begin
  if normalized is null then
    return;
  end if;

  update public.buildings b
     set observed_listings = (
       select count(*) from (
         select l.building_name from public.residential_sale_listings l
          where l.building_name is not null
            and (lower(trim(l.building_name)) = lower(trim(b.canonical_name))
              or exists (select 1 from public.building_name_aliases a
                          where a.building_id = b.id
                            and lower(trim(a.alias)) = lower(trim(l.building_name))))
         union all select l.building_name from public.residential_rent_listings l
          where l.building_name is not null
            and (lower(trim(l.building_name)) = lower(trim(b.canonical_name))
              or exists (select 1 from public.building_name_aliases a
                          where a.building_id = b.id
                            and lower(trim(a.alias)) = lower(trim(l.building_name))))
         union all select l.building_name from public.commercial_sale_listings l
          where l.building_name is not null
            and (lower(trim(l.building_name)) = lower(trim(b.canonical_name))
              or exists (select 1 from public.building_name_aliases a
                          where a.building_id = b.id
                            and lower(trim(a.alias)) = lower(trim(l.building_name))))
         union all select l.building_name from public.commercial_rent_listings l
          where l.building_name is not null
            and (lower(trim(l.building_name)) = lower(trim(b.canonical_name))
              or exists (select 1 from public.building_name_aliases a
                          where a.building_id = b.id
                            and lower(trim(a.alias)) = lower(trim(l.building_name))))
       ) names
     )
   where lower(trim(b.canonical_name)) = normalized
      or exists (select 1 from public.building_name_aliases a
                  where a.building_id = b.id
                    and lower(trim(a.alias)) = normalized);
end;
$$;

create or replace function public.refresh_building_observed_listings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_table_name = 'building_name_aliases' then
    if tg_op in ('INSERT', 'UPDATE') then
      perform public.refresh_building_observed_listings_for_name(new.alias);
    end if;
    if tg_op in ('UPDATE', 'DELETE') then
      perform public.refresh_building_observed_listings_for_name(old.alias);
    end if;
    return null;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    perform public.refresh_building_observed_listings_for_name(new.building_name);
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    perform public.refresh_building_observed_listings_for_name(old.building_name);
  end if;
  return null;
end;
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'residential_sale_listings', 'residential_rent_listings',
    'commercial_sale_listings', 'commercial_rent_listings'
  ] loop
    execute format('drop trigger if exists trg_refresh_building_observed_listings_%I on public.%I', t, t);
    execute format(
      'create trigger trg_refresh_building_observed_listings_%I after insert or update of building_name or delete on public.%I for each row execute function public.refresh_building_observed_listings()',
      t, t
    );
  end loop;
end;
$$;
