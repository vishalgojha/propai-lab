-- AI-first extraction support and data-quality invariants.
-- Semantic interpretation remains in the model; this migration only repairs
-- provenance, cache keys, persistence constraints, and quarantine flags.

create extension if not exists pgcrypto;

create table if not exists public.extraction_cache (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  content_hash text not null,
  extraction jsonb not null,
  provider_used text,
  item_count integer not null default 0,
  hit_count integer not null default 0,
  created_at timestamptz not null default now(),
  last_hit_at timestamptz,
  unique (tenant_id, content_hash)
);

create or replace function public.increment_extraction_cache_hit(p_id bigint)
returns void language sql security definer set search_path = public as $fn$
  update public.extraction_cache
     set hit_count = hit_count + 1, last_hit_at = now()
   where id = p_id;
$fn$;

-- Raw-message hash backfill is intentionally run separately in bounded
-- batches; the table is over one million rows and must not hold one long
-- migration transaction.
create index if not exists idx_raw_messages_hash_tenant
  on public.raw_messages (tenant_id, message_hash);

-- Repair only unambiguous historical aliases. AI remains responsible for
-- semantic matches; this merely restores missing foreign-key persistence.
update public.building_name_aliases a
   set building_id = b.id, canonical_name = b.canonical_name
  from public.buildings b
 where a.building_id is null
   and regexp_replace(lower(trim(a.alias)), '[^a-z0-9]+', '', 'g') =
       regexp_replace(lower(trim(b.canonical_name)), '[^a-z0-9]+', '', 'g')
   and (a.tenant_id is null or b.tenant_id is null or a.tenant_id = b.tenant_id)
   and 1 = (
     select count(*) from public.buildings candidate
      where regexp_replace(lower(trim(candidate.canonical_name)), '[^a-z0-9]+', '', 'g') =
            regexp_replace(lower(trim(a.alias)), '[^a-z0-9]+', '', 'g')
        and (a.tenant_id is null or candidate.tenant_id is null or a.tenant_id = candidate.tenant_id)
   );

update public.resolver_decisions
   set final_confidence = 0.0
 where building_id is null or coalesce(method, 'unresolved') in ('unresolved', 'error');

do $$
declare t text;
begin
  foreach t in array array[
    'residential_sale_listings','residential_rent_listings',
    'commercial_sale_listings','commercial_rent_listings',
    'residential_sale_requirements','residential_rent_requirements',
    'commercial_sale_requirements','commercial_rent_requirements'
  ] loop
    execute format('alter table public.%I add column if not exists extraction_confidence_score numeric', t);
    execute format($sql$
      update public.%I
         set extraction_confidence_score = case extraction_confidence
           when 'high' then 0.9 when 'medium' then 0.7 when 'low' then 0.4
           else null end
       where extraction_confidence_score is null
    $sql$, t);
  end loop;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'residential_sale_listings','residential_rent_listings',
    'commercial_sale_listings','commercial_rent_listings',
    'residential_sale_requirements','residential_rent_requirements',
    'commercial_sale_requirements','commercial_rent_requirements'
  ] loop
    execute format('alter table public.%I add column if not exists availability_status text', t);
    execute format('alter table public.%I add column if not exists price_basis text', t);
    execute format($sql$
      update public.%I set availability_status = 'not_specified'
       where availability_status is not null and lower(availability_status) not in ('available','sold','let_out','withdrawn','closed','not_specified')
    $sql$, t);
    execute format($sql$
      alter table public.%I drop constraint if exists %I;
      alter table public.%I add constraint %I check (availability_status is null or availability_status in ('available','sold','let_out','withdrawn','closed','not_specified')) not valid;
    $sql$, t, t || '_availability_status_check', t, t || '_availability_status_check');
    if t not like '%requirements' then
      execute format($sql$
        update public.%I set price_basis = 'not_specified'
         where price_basis is not null and lower(price_basis) not in ('carpet','built_up','super_built_up','saleable','not_specified');
        alter table public.%I drop constraint if exists %I;
        alter table public.%I add constraint %I check (price_basis is null or price_basis in ('carpet','built_up','super_built_up','saleable','not_specified')) not valid;
      $sql$, t, t, t || '_price_basis_check', t, t || '_price_basis_check');
    end if;
  end loop;
end $$;

-- Duplicate cleanup and unique indexes are applied separately in bounded
-- batches so a large historical table cannot time out this migration.

-- Turn known legacy enum spellings into explicit review values. New writes
-- must use the canonical values from the AI schema.
do $$
declare t text;
begin
  foreach t in array array[
    'residential_sale_listings','residential_rent_listings',
    'commercial_sale_listings','commercial_rent_listings',
    'residential_sale_requirements','residential_rent_requirements',
    'commercial_sale_requirements','commercial_rent_requirements'
  ] loop
    execute format($sql$
      update public.%I
         set furnishing_status = 'not_specified',
             validation_flags = coalesce(validation_flags, '[]'::jsonb) || jsonb_build_array('legacy_noncanonical_furnishing')
       where furnishing_status is not null
         and lower(furnishing_status) not in ('fully_furnished','semi_furnished','unfurnished','bare_shell','builder_finish','not_specified')
    $sql$, t);
    execute format($sql$
      update public.%I
         set possession_status = 'not_specified',
             validation_flags = coalesce(validation_flags, '[]'::jsonb) || jsonb_build_array('legacy_noncanonical_possession')
       where possession_status is not null
         and lower(possession_status) not in ('ready_to_move','under_construction','ready_possession','oc_received','preleased','not_specified')
    $sql$, t);
    execute format($sql$
      alter table public.%I drop constraint if exists %I;
      alter table public.%I add constraint %I check (furnishing_status is null or furnishing_status in ('fully_furnished','semi_furnished','unfurnished','bare_shell','builder_finish','not_specified')) not valid;
      alter table public.%I drop constraint if exists %I;
      alter table public.%I add constraint %I check (possession_status is null or possession_status in ('ready_to_move','under_construction','ready_possession','oc_received','preleased','not_specified')) not valid;
      alter table public.%I drop constraint if exists %I;
      alter table public.%I add constraint %I check (transaction_type is null or transaction_type in ('sale','rent','lease','pg','joint_venture','requirement')) not valid;
    $sql$, t, t || '_furnishing_status_check', t, t || '_furnishing_status_check', t, t || '_possession_status_check', t, t || '_possession_status_check', t, t || '_transaction_type_check', t, t || '_transaction_type_check');
  end loop;
end $$;

-- Populate flags for the high-value impossible values already in storage.
do $$
declare t text;
begin
  foreach t in array array['residential_sale_listings','residential_rent_listings','commercial_sale_listings','commercial_rent_listings'] loop
    execute format($sql$
      update public.%I
         set validation_flags = coalesce(validation_flags, '[]'::jsonb) || jsonb_build_array('bhk_too_high')
       where bhk > 10 and not coalesce(validation_flags, '[]'::jsonb) @> '["bhk_too_high"]'::jsonb
    $sql$, t);
    execute format($sql$
      update public.%I
         set validation_flags = coalesce(validation_flags, '[]'::jsonb) || jsonb_build_array('area_out_of_range')
       where (carpet_area_sqft is not null and (carpet_area_sqft < 100 or carpet_area_sqft > 100000))
          or (built_up_area_sqft is not null and (built_up_area_sqft < 100 or built_up_area_sqft > 100000))
    $sql$, t);
  end loop;
end $$;
