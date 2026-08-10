-- Locality quality backfill.
-- Keep locality_raw/locality_resolved as the source audit trail.  The FK and
-- status columns are additive so existing extraction output is never erased.

alter table if exists public.residential_sale_listings
  add column if not exists locality_id bigint references public.locality_reference(id),
  add column if not exists locality_match_status text;
alter table if exists public.residential_rent_listings
  add column if not exists locality_id bigint references public.locality_reference(id),
  add column if not exists locality_match_status text;
alter table if exists public.commercial_sale_listings
  add column if not exists locality_id bigint references public.locality_reference(id),
  add column if not exists locality_match_status text;
alter table if exists public.commercial_rent_listings
  add column if not exists locality_id bigint references public.locality_reference(id),
  add column if not exists locality_match_status text;

create index if not exists idx_residential_sale_locality_id
  on public.residential_sale_listings(locality_id);
create index if not exists idx_residential_rent_locality_id
  on public.residential_rent_listings(locality_id);
create index if not exists idx_commercial_sale_locality_id
  on public.commercial_sale_listings(locality_id);
create index if not exists idx_commercial_rent_locality_id
  on public.commercial_rent_listings(locality_id);

-- These are unambiguous street/landmark forms seen in the unmatched audit.
-- Do not add bare Andheri, Bandra, Khar, or Santacruz here: the source audit
-- shows those values crossing multiple properties in compound messages.
update public.locality_reference
   set alternate_names = (
     select array_agg(distinct value order by value)
       from unnest(coalesce(alternate_names, array[]::text[]) ||
                   array['Khar 15th Road', 'Khar (15th Road)', 'Khar Gymkhana']) value
   ),
       updated_at = now()
 where id = 31;

update public.locality_reference
   set alternate_names = (
     select array_agg(distinct value order by value)
       from unnest(coalesce(alternate_names, array[]::text[]) ||
                   array['Bandra (16th Road)', 'Pali Mala Road, Bandra']) value
   ),
       updated_at = now()
 where id = 15;

do $$
declare
  t text;
begin
  foreach t in array array[
    'residential_sale_listings', 'residential_rent_listings',
    'commercial_sale_listings', 'commercial_rent_listings'
  ] loop
    execute format($sql$
      with candidates as (
        select l.id, r.id as locality_id
          from public.%I l
          cross join lateral (
            select lr.id
              from public.locality_reference lr
             where lower(regexp_replace(btrim(coalesce(l.locality_resolved, '')), '\s+', ' ', 'g')) =
                   lower(regexp_replace(btrim(lr.sub_locality), '\s+', ' ', 'g'))
                or lower(regexp_replace(btrim(coalesce(l.locality_resolved, '')), '\s+', ' ', 'g')) =
                   lower(regexp_replace(btrim(lr.parent_locality), '\s+', ' ', 'g'))
                or exists (
                  select 1
                    from unnest(coalesce(lr.alternate_names, array[]::text[])) a(name)
                   where lower(regexp_replace(btrim(coalesce(l.locality_resolved, '')), '\s+', ' ', 'g')) =
                         lower(regexp_replace(btrim(a.name), '\s+', ' ', 'g'))
                )
             order by case when lr.confidence = 'high' then 0 when lr.confidence = 'medium' then 1 else 2 end,
                      lr.id
             limit 1
          ) r
         where nullif(btrim(l.locality_resolved), '') is not null
      )
      update public.%I l
         set locality_id = c.locality_id,
             locality_match_status = 'matched'
        from candidates c
       where l.id = c.id
    $sql$, t, t);

    execute format($sql$
      update public.%I l
         set locality_match_status = case
           when exists (
             select 1 from public.buildings b
              where lower(btrim(coalesce(b.canonical_name, ''))) =
                    lower(regexp_replace(btrim(coalesce(l.locality_resolved, '')), '\s+', ' ', 'g'))
           ) or lower(coalesce(l.locality_resolved, '')) ~
                 '(residency|residencies|heights|garden|court|tower|apartments?|society|building)'
             then 'likely_building_name'
           when nullif(btrim(l.locality_resolved), '') is null then 'missing'
           else 'unmatched'
         end
       where l.locality_id is null
         and (l.locality_match_status is null or l.locality_match_status <> 'matched')
    $sql$, t);
  end loop;
end;
$$;

create table if not exists public.data_quality_backfill_runs (
  id bigint generated always as identity primary key,
  run_name text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);

insert into public.data_quality_backfill_runs(run_name, details)
select 'locality_reference_fk_backfill', jsonb_build_object(
  'reference_rows', (select count(*) from public.locality_reference),
  'reference_alternate_names', (select coalesce(sum(coalesce(array_length(alternate_names, 1), 0)), 0) from public.locality_reference),
  'sale_residential_matched', (select count(*) from public.residential_sale_listings where locality_id is not null),
  'rent_residential_matched', (select count(*) from public.residential_rent_listings where locality_id is not null),
  'sale_commercial_matched', (select count(*) from public.commercial_sale_listings where locality_id is not null),
  'rent_commercial_matched', (select count(*) from public.commercial_rent_listings where locality_id is not null),
  'likely_building_name_flags', (
    select count(*) from public.residential_sale_listings where locality_match_status = 'likely_building_name'
  ) + (
    select count(*) from public.residential_rent_listings where locality_match_status = 'likely_building_name'
  ) + (
    select count(*) from public.commercial_sale_listings where locality_match_status = 'likely_building_name'
  ) + (
    select count(*) from public.commercial_rent_listings where locality_match_status = 'likely_building_name'
  )
);
