-- Manual rollback for 20260811190000_repair_ambiguous_locality_assignments.sql.
-- Run only after reviewing rows whose current locality still equals the value
-- written by that repair. The audit rows are retained as evidence.

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
         set locality_id = a.old_locality_id,
             locality_match_status = a.old_match_status
        from public.locality_assignment_repair_audit a
       where a.run_name = 'repair_ambiguous_locality_assignments_v1'
         and a.table_name = %L
         and a.applied_at is not null
         and a.rolled_back_at is null
         and a.listing_id = l.id
         and l.locality_id is not distinct from a.new_locality_id
         and l.locality_match_status is not distinct from a.new_match_status
    $sql$, t, t);
  end loop;
end;
$$;

update public.locality_assignment_repair_audit a
   set rolled_back_at = now()
 where a.run_name = 'repair_ambiguous_locality_assignments_v1'
   and a.applied_at is not null
   and a.rolled_back_at is null
   and (
     (a.table_name = 'residential_sale_listings' and exists (
       select 1 from public.residential_sale_listings l
        where l.id = a.listing_id
          and l.locality_id is not distinct from a.old_locality_id
          and l.locality_match_status is not distinct from a.old_match_status
     )) or
     (a.table_name = 'residential_rent_listings' and exists (
       select 1 from public.residential_rent_listings l
        where l.id = a.listing_id
          and l.locality_id is not distinct from a.old_locality_id
          and l.locality_match_status is not distinct from a.old_match_status
     )) or
     (a.table_name = 'commercial_sale_listings' and exists (
       select 1 from public.commercial_sale_listings l
        where l.id = a.listing_id
          and l.locality_id is not distinct from a.old_locality_id
          and l.locality_match_status is not distinct from a.old_match_status
     )) or
     (a.table_name = 'commercial_rent_listings' and exists (
       select 1 from public.commercial_rent_listings l
        where l.id = a.listing_id
          and l.locality_id is not distinct from a.old_locality_id
          and l.locality_match_status is not distinct from a.old_match_status
     ))
   );

insert into public.data_quality_backfill_runs(run_name, details)
select 'rollback_repair_ambiguous_locality_assignments_v1', jsonb_build_object(
  'rolled_back_rows', count(*) filter (where rolled_back_at is not null),
  'source_run', 'repair_ambiguous_locality_assignments_v1'
)
from public.locality_assignment_repair_audit
where run_name = 'repair_ambiguous_locality_assignments_v1';
