-- Repair locality_id assignments made by the one-time 20260811033000
-- backfill. That migration allowed locality_resolved to match any row whose
-- parent_locality had the same text and then selected the first child by
-- confidence/id. This repair is deliberately narrower:
--
-- 1. Inspect only rows already marked matched with a non-null locality_id.
-- 2. Prefer an exact normalized locality_raw sub-locality/alias, then an
--    exact locality_resolved match, then an exact micro_market match.
-- 3. Reassign only when that highest-priority evidence maps to exactly one
--    canonical row.
-- 4. Clear rows produced by an ambiguous parent-only match instead of
--    selecting another child.
-- 5. Preserve locality_raw, locality_resolved, and micro_market verbatim.

create table if not exists public.locality_assignment_repair_audit (
  id bigint generated always as identity primary key,
  run_name text not null,
  table_name text not null check (table_name in (
    'residential_sale_listings', 'residential_rent_listings',
    'commercial_sale_listings', 'commercial_rent_listings'
  )),
  listing_id bigint not null,
  tenant_id uuid,
  old_locality_id bigint,
  old_match_status text,
  new_locality_id bigint,
  new_match_status text not null,
  reason text not null,
  evidence_field text not null,
  locality_raw text,
  locality_resolved text,
  micro_market text,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  rolled_back_at timestamptz,
  unique (run_name, table_name, listing_id)
);

create index if not exists idx_locality_assignment_repair_audit_run
  on public.locality_assignment_repair_audit(run_name, table_name);

alter table public.locality_assignment_repair_audit enable row level security;
revoke all on table public.locality_assignment_repair_audit from anon, authenticated;
grant select, insert, update on table public.locality_assignment_repair_audit to service_role;

create temporary table locality_assignment_repair_candidates
on commit drop
as
with ref_tokens as materialized (
  select id,
         lower(regexp_replace(btrim(sub_locality), '[[:space:]]+', ' ', 'g')) as token
    from public.locality_reference
   where nullif(btrim(sub_locality), '') is not null
  union all
  select lr.id,
         lower(regexp_replace(btrim(a.name), '[[:space:]]+', ' ', 'g'))
    from public.locality_reference lr
    cross join lateral unnest(coalesce(lr.alternate_names, array[]::text[])) a(name)
   where nullif(btrim(a.name), '') is not null
), token_map as materialized (
  select token, array_agg(distinct id order by id) as ids
    from ref_tokens
   group by token
), parent_map as materialized (
  select lower(regexp_replace(btrim(parent_locality), '[[:space:]]+', ' ', 'g')) as token,
         array_agg(id order by id) as child_ids,
         count(*) as child_count
    from public.locality_reference
   where nullif(btrim(parent_locality), '') is not null
   group by lower(regexp_replace(btrim(parent_locality), '[[:space:]]+', ' ', 'g'))
), listings as materialized (
  select 'residential_sale_listings'::text as table_name, id, tenant_id,
         locality_id, locality_match_status, locality_raw,
         locality_resolved, micro_market
    from public.residential_sale_listings
   where locality_id is not null and locality_match_status = 'matched'
  union all
  select 'residential_rent_listings', id, tenant_id, locality_id,
         locality_match_status, locality_raw, locality_resolved, micro_market
    from public.residential_rent_listings
   where locality_id is not null and locality_match_status = 'matched'
  union all
  select 'commercial_sale_listings', id, tenant_id, locality_id,
         locality_match_status, locality_raw, locality_resolved, micro_market
    from public.commercial_sale_listings
   where locality_id is not null and locality_match_status = 'matched'
  union all
  select 'commercial_rent_listings', id, tenant_id, locality_id,
         locality_match_status, locality_raw, locality_resolved, micro_market
    from public.commercial_rent_listings
   where locality_id is not null and locality_match_status = 'matched'
), normalized as materialized (
  select l.*,
         lower(regexp_replace(btrim(coalesce(locality_raw, '')), '[[:space:]]+', ' ', 'g')) as raw_norm,
         lower(regexp_replace(btrim(coalesce(locality_resolved, '')), '[[:space:]]+', ' ', 'g')) as resolved_norm,
         lower(regexp_replace(btrim(coalesce(micro_market, '')), '[[:space:]]+', ' ', 'g')) as market_norm
    from listings l
), evidence as materialized (
  select n.*,
         coalesce(r.ids, array[]::bigint[]) as raw_ids,
         coalesce(v.ids, array[]::bigint[]) as resolved_ids,
         coalesce(m.ids, array[]::bigint[]) as market_ids,
         coalesce(p.child_ids, array[]::bigint[]) as parent_child_ids,
         coalesce(p.child_count, 0) as parent_child_count
    from normalized n
    left join token_map r on r.token = nullif(n.raw_norm, '')
    left join token_map v on v.token = nullif(n.resolved_norm, '')
    left join token_map m on m.token = nullif(n.market_norm, '')
    left join parent_map p on p.token = nullif(n.resolved_norm, '')
), preferred as materialized (
  select e.*,
         case
           when cardinality(raw_ids) > 0 then raw_ids
           when cardinality(resolved_ids) > 0 then resolved_ids
           when cardinality(market_ids) > 0 then market_ids
           else array[]::bigint[]
         end as preferred_ids,
         case
           when cardinality(raw_ids) > 0 then 'locality_raw_exact'
           when cardinality(resolved_ids) > 0 then 'locality_resolved_exact'
           when cardinality(market_ids) > 0 then 'micro_market_exact'
           when parent_child_count > 1 and locality_id = any(parent_child_ids)
             then 'ambiguous_parent_only'
           else 'no_proven_correction'
         end as evidence_field
    from evidence e
), decisions as (
  select p.*,
         case
           when cardinality(preferred_ids) = 1 and preferred_ids[1] <> locality_id
             then preferred_ids[1]
           else null
         end as proposed_locality_id,
         case
           when cardinality(preferred_ids) = 1 and preferred_ids[1] <> locality_id
             then 'reassign_unique_exact_match'
           when cardinality(preferred_ids) > 1
             then 'clear_ambiguous_exact_match'
           when evidence_field = 'ambiguous_parent_only'
             then 'clear_ambiguous_parent_match'
           else null
         end as reason
    from preferred p
)
select table_name, id as listing_id, tenant_id,
       locality_id as old_locality_id,
       locality_match_status as old_match_status,
       proposed_locality_id as new_locality_id,
       case when proposed_locality_id is null then 'ambiguous' else 'matched' end as new_match_status,
       reason, evidence_field, locality_raw, locality_resolved, micro_market
  from decisions
 where reason is not null;

do $$
begin
  if exists (
    select 1
      from locality_assignment_repair_candidates
     where new_locality_id is not null
       and new_locality_id = old_locality_id
  ) then
    raise exception 'locality repair candidate attempted a no-op reassignment';
  end if;
end;
$$;

insert into public.locality_assignment_repair_audit (
  run_name, table_name, listing_id, tenant_id,
  old_locality_id, old_match_status, new_locality_id, new_match_status,
  reason, evidence_field, locality_raw, locality_resolved, micro_market
)
select 'repair_ambiguous_locality_assignments_v1', table_name, listing_id,
       tenant_id, old_locality_id, old_match_status, new_locality_id,
       new_match_status, reason, evidence_field, locality_raw,
       locality_resolved, micro_market
  from locality_assignment_repair_candidates
on conflict (run_name, table_name, listing_id) do nothing;

do $$
declare
  t text;
begin
  foreach t in array array[
    'residential_sale_listings', 'residential_rent_listings',
    'commercial_sale_listings', 'commercial_rent_listings'
  ] loop
    execute format($sql$
      update public.%I l
         set locality_id = a.new_locality_id,
             locality_match_status = a.new_match_status
        from public.locality_assignment_repair_audit a
       where a.run_name = 'repair_ambiguous_locality_assignments_v1'
         and a.table_name = %L
         and a.listing_id = l.id
         and l.locality_id is not distinct from a.old_locality_id
         and l.locality_match_status is not distinct from a.old_match_status
    $sql$, t, t);
  end loop;
end;
$$;

update public.locality_assignment_repair_audit a
   set applied_at = now()
 where a.run_name = 'repair_ambiguous_locality_assignments_v1'
   and a.applied_at is null
   and (
     (a.table_name = 'residential_sale_listings' and exists (
       select 1 from public.residential_sale_listings l
        where l.id = a.listing_id
          and l.locality_id is not distinct from a.new_locality_id
          and l.locality_match_status is not distinct from a.new_match_status
     )) or
     (a.table_name = 'residential_rent_listings' and exists (
       select 1 from public.residential_rent_listings l
        where l.id = a.listing_id
          and l.locality_id is not distinct from a.new_locality_id
          and l.locality_match_status is not distinct from a.new_match_status
     )) or
     (a.table_name = 'commercial_sale_listings' and exists (
       select 1 from public.commercial_sale_listings l
        where l.id = a.listing_id
          and l.locality_id is not distinct from a.new_locality_id
          and l.locality_match_status is not distinct from a.new_match_status
     )) or
     (a.table_name = 'commercial_rent_listings' and exists (
       select 1 from public.commercial_rent_listings l
        where l.id = a.listing_id
          and l.locality_id is not distinct from a.new_locality_id
          and l.locality_match_status is not distinct from a.new_match_status
     ))
   );

insert into public.data_quality_backfill_runs(run_name, details)
select 'repair_ambiguous_locality_assignments_v1', jsonb_build_object(
  'audited_rows', count(*),
  'applied_rows', count(*) filter (where applied_at is not null),
  'reassigned_rows', count(*) filter (where new_locality_id is not null),
  'cleared_ambiguous_rows', count(*) filter (where new_locality_id is null),
  'policy', 'unique exact sub-locality/alias evidence; ambiguous parent-only matches cleared'
)
from public.locality_assignment_repair_audit
where run_name = 'repair_ambiguous_locality_assignments_v1';
