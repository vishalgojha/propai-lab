-- Promote verified Google Places building addresses into typed locality links.
--
-- This migration is deliberately conservative:
--   * only unresolved typed rows are candidates;
--   * matched rows are never selected;
--   * a unique reference row and parent are required for promotion;
--   * conflicting and incomplete evidence is retained as a validation flag;
--   * no outcome changes needs_review.

-- Complete the requested Bandra West vocabulary without attaching a road to
-- an unrelated existing child locality. Existing rows are updated only with
-- explicitly equivalent aliases; road-only labels get their own reference row.
insert into public.locality_reference
  (sub_locality, parent_locality, city, alternate_names, landmarks,
   confidence, source, notes, sort_order, canonical_locality)
select v.sub_locality, 'Bandra West', 'Mumbai', v.alternate_names, '{}',
       'high', 'seed', 'Phase 3 Google Places locality promotion vocabulary',
       30, 'Bandra West'
  from (values
    ('Bandra West'::text, array[]::text[]),
    ('16th Road'::text, array['16th Rd']::text[]),
    ('20th Road'::text, array['20th Rd']::text[])
  ) v(sub_locality, alternate_names)
 where not exists (
   select 1 from public.locality_reference lr
    where lower(trim(lr.sub_locality)) = lower(trim(v.sub_locality))
      and lower(trim(lr.parent_locality)) = 'bandra west'
 );

update public.locality_reference lr
   set alternate_names = (
     select array_agg(distinct value order by value)
       from unnest(coalesce(lr.alternate_names, array[]::text[]) ||
                   array['Perry Cross Road', 'Perry Cross Rd']::text[]) value
   ), updated_at = now()
 where lower(trim(lr.sub_locality)) = 'perry road'
   and lower(trim(lr.parent_locality)) = 'bandra west'
   and not exists (
     select 1
       from public.locality_reference other
      where other.id <> lr.id
        and lower(trim(other.sub_locality)) = any(array['perry cross road', 'perry cross rd'])
   );

create temporary table _places_locality_decisions on commit drop as
with ref_tokens as materialized (
  -- Child/alias/landmark evidence is more precise than a bare parent label.
  select lr.id, lr.parent_locality, lr.canonical_locality,
         lower(regexp_replace(regexp_replace(trim(lr.sub_locality),
           '[^a-zA-Z0-9]+', ' ', 'g'), '\s+', ' ', 'g')) as token,
         case when lower(trim(lr.sub_locality)) = lower(trim(lr.parent_locality))
              then 1 else 0 end as parent_only
    from public.locality_reference lr
   where nullif(trim(lr.sub_locality), '') is not null
  union all
  select lr.id, lr.parent_locality, lr.canonical_locality,
         lower(regexp_replace(regexp_replace(trim(a.name),
           '[^a-zA-Z0-9]+', ' ', 'g'), '\s+', ' ', 'g')),
         0
    from public.locality_reference lr
    cross join lateral unnest(coalesce(lr.alternate_names, array[]::text[])) a(name)
   where nullif(trim(a.name), '') is not null
  union all
  select lr.id, lr.parent_locality, lr.canonical_locality,
         lower(regexp_replace(regexp_replace(trim(l.name),
           '[^a-zA-Z0-9]+', ' ', 'g'), '\s+', ' ', 'g')),
         0
    from public.locality_reference lr
    cross join lateral unnest(coalesce(lr.landmarks, array[]::text[])) l(name)
   where nullif(trim(l.name), '') is not null
), tokens as materialized (
  select distinct id, parent_locality, canonical_locality, token, parent_only
    from ref_tokens
   where length(token) >= 4
), typed_rows as materialized (
  select 'residential_sale_listings'::text table_name, id row_id,
         building_id, locality_id, locality_match_status
    from public.residential_sale_listings
   where locality_id is null and locality_match_status in ('missing', 'unmatched')
  union all select 'residential_rent_listings', id, building_id, locality_id, locality_match_status
    from public.residential_rent_listings
   where locality_id is null and locality_match_status in ('missing', 'unmatched')
  union all select 'commercial_sale_listings', id, building_id, locality_id, locality_match_status
    from public.commercial_sale_listings
   where locality_id is null and locality_match_status in ('missing', 'unmatched')
  union all select 'commercial_rent_listings', id, building_id, locality_id, locality_match_status
    from public.commercial_rent_listings
   where locality_id is null and locality_match_status in ('missing', 'unmatched')
  union all select 'residential_sale_requirements', id, building_id, locality_id, locality_match_status
    from public.residential_sale_requirements
   where locality_id is null and locality_match_status in ('missing', 'unmatched')
  union all select 'residential_rent_requirements', id, building_id, locality_id, locality_match_status
    from public.residential_rent_requirements
   where locality_id is null and locality_match_status in ('missing', 'unmatched')
  union all select 'commercial_sale_requirements', id, building_id, locality_id, locality_match_status
    from public.commercial_sale_requirements
   where locality_id is null and locality_match_status in ('missing', 'unmatched')
  union all select 'commercial_rent_requirements', id, building_id, locality_id, locality_match_status
    from public.commercial_rent_requirements
   where locality_id is null and locality_match_status in ('missing', 'unmatched')
), places_addresses as materialized (
  select distinct on (building_id) building_id, field_value as address,
         confidence
    from public.building_enrichment_sources
   where provider = 'google_places'
     and field_name = 'address'
     and nullif(trim(field_value), '') is not null
     and confidence >= 0.90
   order by building_id, confidence desc, enriched_at desc nulls last, id desc
), matched_tokens as materialized (
  select r.table_name, r.row_id, r.building_id, p.confidence,
         t.id locality_id, t.parent_locality, t.canonical_locality,
         t.parent_only, t.token
    from typed_rows r
    join places_addresses p on p.building_id = r.building_id
    join tokens t on position(
      t.token in lower(regexp_replace(regexp_replace(trim(p.address),
        '[^a-zA-Z0-9]+', ' ', 'g'), '\s+', ' ', 'g'))
    ) > 0
), ranked as materialized (
  select m.*,
         min(parent_only) over (partition by table_name, row_id) best_parent_only
    from matched_tokens m
), decisions as (
  select table_name, row_id, building_id, confidence,
         case
           when count(distinct parent_locality) = 0 then 'no_reference'
           when count(distinct parent_locality) > 1 then 'ambiguous_parent'
           when count(distinct locality_id) = 1 then 'deterministic'
           else 'ambiguous_child'
         end outcome,
         min(parent_locality) parent_locality,
         array_agg(distinct locality_id order by locality_id) locality_ids
    from ranked
   where parent_only = best_parent_only
   group by table_name, row_id, building_id, confidence
), eligible_without_match as (
  select r.table_name, r.row_id, r.building_id, p.confidence,
         'no_reference' outcome, null::text parent_locality,
         array[]::bigint[] locality_ids
    from typed_rows r
    join places_addresses p on p.building_id = r.building_id
   where not exists (
     select 1 from decisions d
      where d.table_name = r.table_name and d.row_id = r.row_id
   )
)
select * from decisions
union all
select * from eligible_without_match;

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
      update public.%I row
         set locality_resolved = d.parent_locality,
             locality_id = d.locality_ids[1],
             locality_match_status = 'matched',
             locality_confidence = case when d.confidence >= 0.95 then 'high' else 'medium' end,
             validation_flags = case
               when jsonb_typeof(coalesce(row.validation_flags, '[]'::jsonb)) = 'array'
                 then coalesce(row.validation_flags, '[]'::jsonb)
               else '[]'::jsonb
             end
        from _places_locality_decisions d
       where d.table_name = %L
         and d.row_id = row.id
         and d.outcome = 'deterministic'
         and row.locality_id is null
         and row.locality_match_status in ('missing', 'unmatched')
    $sql$, table_name, table_name);

    execute format($sql$
      update public.%I row
         set validation_flags = case
           when jsonb_typeof(coalesce(row.validation_flags, '[]'::jsonb)) = 'array'
             then coalesce(row.validation_flags, '[]'::jsonb)
           else '[]'::jsonb
         end || case d.outcome
           when 'ambiguous_parent' then '["building_places_locality_ambiguous"]'::jsonb
           when 'ambiguous_child' then '["building_places_locality_child_ambiguous"]'::jsonb
           else '["building_places_locality_no_reference"]'::jsonb
         end
        from _places_locality_decisions d
       where d.table_name = %L
         and d.row_id = row.id
         and d.outcome <> 'deterministic'
         and row.locality_id is null
         and row.locality_match_status in ('missing', 'unmatched')
         and not (
           coalesce(row.validation_flags, '[]'::jsonb) ? case d.outcome
             when 'ambiguous_parent' then 'building_places_locality_ambiguous'
             when 'ambiguous_child' then 'building_places_locality_child_ambiguous'
             else 'building_places_locality_no_reference'
           end
         )
    $sql$, table_name, table_name);
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
select 'places_building_locality_promotion_20260904', jsonb_build_object(
  'deterministic_rows', count(*) filter (where outcome = 'deterministic'),
  'ambiguous_parent_rows', count(*) filter (where outcome = 'ambiguous_parent'),
  'ambiguous_child_rows', count(*) filter (where outcome = 'ambiguous_child'),
  'no_reference_rows', count(*) filter (where outcome = 'no_reference'),
  'eligible_rows', count(*),
  'confidence_ge_095', count(*) filter (where confidence >= 0.95),
  'confidence_090_to_0949', count(*) filter (where confidence >= 0.90 and confidence < 0.95),
  'tables', (select jsonb_object_agg(table_name, counts)
              from (select table_name, jsonb_build_object(
                       'deterministic', count(*) filter (where outcome = 'deterministic'),
                       'ambiguous_parent', count(*) filter (where outcome = 'ambiguous_parent'),
                       'ambiguous_child', count(*) filter (where outcome = 'ambiguous_child'),
                       'no_reference', count(*) filter (where outcome = 'no_reference')) counts
                      from _places_locality_decisions group by table_name) x)
)
from _places_locality_decisions;
