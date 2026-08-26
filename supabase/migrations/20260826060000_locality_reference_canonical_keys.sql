-- Make locality_reference the single canonical resolution source.
-- `parent_locality` is retained for backwards compatibility; canonical_locality
-- is the stable key consumed by extraction, backfills, and public reads.
alter table public.locality_reference
  add column if not exists canonical_locality text;

update public.locality_reference
set canonical_locality = case
  when lower(trim(parent_locality)) in ('bkc', 'bandra kurla complex')
    then 'Bandra Kurla Complex'
  else nullif(trim(parent_locality), '')
end
where canonical_locality is null;

alter table public.locality_reference
  alter column canonical_locality set not null;

create index if not exists locality_reference_canonical_locality_idx
  on public.locality_reference (lower(canonical_locality));
