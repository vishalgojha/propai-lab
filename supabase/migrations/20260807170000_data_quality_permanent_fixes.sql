-- PropAI data-quality repair.  The application guards live in
-- building_quality.py and storage/supabase.py; this migration repairs old
-- rows and installs database-side invariants for future typed-listing writes.

create table if not exists public.data_quality_backfill_runs (
  id bigint generated always as identity primary key,
  run_name text not null,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);

alter table public.brokers alter column canonical_name drop not null;

-- 1. Never persist a WhatsApp JID as a human name.  The LID map is the
-- durable identity source available in this schema; unresolved users retain
-- their already-known phone, otherwise become NULL.
do $$
declare
  broker_fixed integer := 0;
  listing_fixed integer := 0;
  resolver_fixed integer := 0;
  broker_phone_fallback integer := 0;
  broker_unresolved integer := 0;
  t text;
  n integer;
begin
  select count(*) filter (where nullif(btrim(primary_phone), '') is not null),
         count(*) filter (where nullif(btrim(primary_phone), '') is null)
    into broker_phone_fallback, broker_unresolved
    from public.brokers
   where canonical_name ~* '@(s\.whatsapp\.net|lid|g\.us)$';
  update public.brokers b
     set canonical_name = nullif(btrim(coalesce(b.primary_phone, '')), '')
   where b.canonical_name ~* '@(s\.whatsapp\.net|lid|g\.us)$';
  get diagnostics broker_fixed = row_count;

  -- broker_phone is authoritative for listing rows.  Do not expose the JID.
  for t in select unnest(array[
    'residential_sale_listings','residential_rent_listings',
    'commercial_sale_listings','commercial_rent_listings'
  ]) loop
    execute format($sql$
      update public.%I
         set broker_name = nullif(btrim(broker_phone), '')
       where broker_name ~* '@(s\.whatsapp\.net|lid|g\.us)$'
    $sql$, t);
    get diagnostics n = row_count;
    listing_fixed := listing_fixed + n;
  end loop;

  -- resolver_decisions has no broker-name column; its building fields are
  -- intentionally untouched.  Record the explicit zero so the audit is
  -- honest and future schema additions can extend this repair.
  insert into public.data_quality_backfill_runs(run_name, details)
  values ('jid_name_cleanup', jsonb_build_object(
    'brokers_phone_fallback', broker_phone_fallback,
    'brokers_total_fixed', broker_fixed,
    'brokers_with_no_phone_unresolved', broker_unresolved,
    'listings_phone_fallback', listing_fixed,
    'contact_names_resolved', 0,
    'resolver_decisions_name_fields', resolver_fixed,
    'unresolved_policy', 'NULL when no phone is available'
  ));
end $$;

-- 2. The extractor stores location as {raw_mention,resolved_locality}; older
-- code only handled a string and silently dropped the object.  Backfill the
-- two evidence columns without inventing locality values.
do $$
declare t text; n integer; total integer := 0;
begin
  for t in select unnest(array[
    'residential_sale_listings','residential_rent_listings',
    'commercial_sale_listings','commercial_rent_listings'
  ]) loop
    execute format($sql$
      update public.%I
         set locality_raw = coalesce(locality_raw,
           nullif(ai_extraction #>> '{location,raw_mention}', ''),
           nullif(ai_extraction #>> '{location,raw}', ''),
           nullif(ai_extraction #>> '{location,label}', ''),
           nullif(area_raw_text, '')),
             locality_resolved = coalesce(locality_resolved,
           nullif(ai_extraction #>> '{location,resolved_locality}', ''),
           nullif(ai_extraction #>> '{location,canonical}', ''),
           nullif(micro_market, ''))
       where locality_raw is null or locality_resolved is null
    $sql$, t);
    get diagnostics n = row_count; total := total + n;
  end loop;
  insert into public.data_quality_backfill_runs(run_name, details)
  values ('locality_columns_backfill', jsonb_build_object('rows_touched', total));
end $$;

-- 3. Reconcile case-only building duplicates using the same deterministic
-- casing policy as the application.  The alias table is the only building FK
-- used by current typed listings; stats are name-keyed historical projections.
create or replace function public.normalize_building_name_for_quality(input text)
returns text language sql immutable as $fn$
  select regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
    initcap(lower(trim(input))), '\mhdil\M', 'HDIL', 'gi'), '\mvip\M', 'VIP', 'gi'), '\mlic\M', 'LIC', 'gi'), '\map\M', 'AP', 'gi'), '\mar\M', 'AR', 'gi'), '\mdlh\M', 'DLH', 'gi'), '\mins\M', 'INS', 'gi'), '\mdgs\M', 'DGS', 'gi'), '\mng\M', 'NG', 'gi'), '\mrna\M', 'RNA', 'gi'), '\mchs\M', 'CHS', 'gi');
$fn$;

update public.buildings
   set canonical_name = public.normalize_building_name_for_quality(canonical_name)
 where canonical_name is not null;
update public.building_name_aliases a
   set canonical_name = b.canonical_name
  from public.buildings b
 where b.id = a.building_id;

do $$
declare r record; winner bigint; loser bigint; merged integer := 0;
begin
  for r in
    select lower(trim(canonical_name)) as key, min(id) as keep_id
      from public.buildings
     group by lower(trim(canonical_name)) having count(*) > 1
  loop
    winner := r.keep_id;
    for loser in select id from public.buildings
      where lower(trim(canonical_name)) = r.key and id <> winner loop
      update public.building_name_aliases
         set building_id = winner,
             canonical_name = (select canonical_name from public.buildings where id = winner)
       where building_id = loser;
      update public.broker_building_stats
         set building_name = (select canonical_name from public.buildings where id = winner)
       where lower(trim(building_name)) = r.key;
      delete from public.buildings where id = loser;
      merged := merged + 1;
    end loop;
  end loop;
  insert into public.data_quality_backfill_runs(run_name, details)
  values ('building_case_dedup', jsonb_build_object('loser_rows_deleted', merged));
end $$;

-- 4. Remove only unobserved, unreferenced chatter rows.  Real building rows
-- with a listing or alias are left for review even if their name is unusual.
delete from public.buildings b
 where coalesce(b.observed_listings, 0) = 0
   and lower(trim(b.canonical_name)) in (
     'plzz call', 'plz call', 'pls call', 'thanks and regards',
     'thanks and regards', 'ownership', 'untouch flat', 'old bldg',
     'old building', 'call', 'regards'
   )
   and not exists (select 1 from public.building_name_aliases a where a.building_id = b.id);
insert into public.data_quality_backfill_runs(run_name, details)
values ('building_junk_cleanup', jsonb_build_object('policy', 'observed_listings=0 and no aliases'));

-- 5. Counter maintenance is based on canonical names and aliases, not on an
-- exact-text join.  This function is deliberately a full recompute: a typed
-- listing can be updated or deleted, so an increment-only counter drifts.
create or replace function public.recompute_building_observed_listings()
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.buildings b
     set observed_listings = (
       select count(*) from (
         select l.building_name from public.residential_sale_listings l
          where l.building_name is not null and (b.tenant_id is null or l.tenant_id=b.tenant_id) and (lower(trim(l.building_name)) = lower(trim(b.canonical_name)) or exists (select 1 from public.building_name_aliases a where a.building_id=b.id and lower(trim(a.alias))=lower(trim(l.building_name))))
         union all select l.building_name from public.residential_rent_listings l
          where l.building_name is not null and (b.tenant_id is null or l.tenant_id=b.tenant_id) and (lower(trim(l.building_name)) = lower(trim(b.canonical_name)) or exists (select 1 from public.building_name_aliases a where a.building_id=b.id and lower(trim(a.alias))=lower(trim(l.building_name))))
         union all select l.building_name from public.commercial_sale_listings l
          where l.building_name is not null and (b.tenant_id is null or l.tenant_id=b.tenant_id) and (lower(trim(l.building_name)) = lower(trim(b.canonical_name)) or exists (select 1 from public.building_name_aliases a where a.building_id=b.id and lower(trim(a.alias))=lower(trim(l.building_name))))
         union all select l.building_name from public.commercial_rent_listings l
          where l.building_name is not null and (b.tenant_id is null or l.tenant_id=b.tenant_id) and (lower(trim(l.building_name)) = lower(trim(b.canonical_name)) or exists (select 1 from public.building_name_aliases a where a.building_id=b.id and lower(trim(a.alias))=lower(trim(l.building_name))))
       ) names
     );
end $$;

create or replace function public.refresh_building_observed_listings()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.recompute_building_observed_listings();
  return null;
end $$;

do $$ declare t text; begin
  foreach t in array array['residential_sale_listings','residential_rent_listings','commercial_sale_listings','commercial_rent_listings'] loop
    execute format('drop trigger if exists trg_refresh_building_observed_listings_%I on public.%I', t, t);
    execute format('create trigger trg_refresh_building_observed_listings_%I after insert or update of building_name or delete on public.%I for each statement execute function public.refresh_building_observed_listings()', t, t);
  end loop;
end $$;

drop trigger if exists trg_refresh_building_observed_listings_aliases on public.building_name_aliases;
create trigger trg_refresh_building_observed_listings_aliases
after insert or update of building_id, alias or delete on public.building_name_aliases
for each statement execute function public.refresh_building_observed_listings();

select public.recompute_building_observed_listings();
insert into public.data_quality_backfill_runs(run_name, details)
values ('building_observed_listings_recompute', jsonb_build_object(
  'buildings_with_listings', (select count(*) from public.buildings where observed_listings > 0),
  'buildings_with_zero', (select count(*) from public.buildings where observed_listings = 0)
));

create or replace view public.data_quality_violations as
select 'broker_jid_name' as check_name, count(*)::bigint as violation_count
  from public.brokers where canonical_name ~* '@(s\.whatsapp\.net|lid|g\.us)$'
union all
select 'listing_jid_name', count(*)::bigint from (
  select broker_name from public.residential_sale_listings union all
  select broker_name from public.residential_rent_listings union all
  select broker_name from public.commercial_sale_listings union all
  select broker_name from public.commercial_rent_listings
) x where broker_name ~* '@(s\.whatsapp\.net|lid|g\.us)$'
union all
select 'building_junk_candidate', count(*)::bigint from public.buildings
 where coalesce(observed_listings, 0) = 0
   and lower(trim(canonical_name)) in ('plzz call','plz call','pls call','thanks and regards','ownership','untouch flat','old bldg','old building');

-- Regression query for scheduled checks / dashboards:
-- select * from public.buildings where canonical_name ~* '@(s\.whatsapp\.net|lid|g\.us)$';
