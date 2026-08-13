-- Reworded reposts are candidate-matched semantically, then classified from
-- structured fields by the ingestion worker.  These columns live only on
-- supply tables: demand records are never collapsed with listings.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'residential_sale_listings',
    'residential_rent_listings',
    'commercial_sale_listings',
    'commercial_rent_listings'
  ] loop
    execute format('alter table public.%I add column if not exists duplicate_status text not null default ''distinct''', table_name);
    execute format('alter table public.%I add column if not exists duplicate_group_id uuid', table_name);
    execute format('alter table public.%I add column if not exists possible_duplicate_source_table text', table_name);
    execute format('alter table public.%I add column if not exists possible_duplicate_source_id bigint', table_name);
    execute format('alter table public.%I add column if not exists possible_duplicate_similarity real', table_name);
    execute format('alter table public.%I add column if not exists repost_count integer not null default 1', table_name);
    execute format('alter table public.%I add column if not exists last_posted_at timestamptz', table_name);
    execute format('alter table public.%I drop constraint if exists %I', table_name, table_name || '_duplicate_status_check');
    execute format('alter table public.%I add constraint %I check (duplicate_status in (''distinct'', ''flagged'', ''merged''))', table_name, table_name || '_duplicate_status_check');
    execute format('create index if not exists %I on public.%I (tenant_id, duplicate_status, last_posted_at desc)', table_name || '_reposts_idx', table_name);
  end loop;
end $$;

update public.residential_sale_listings set last_posted_at = coalesce(last_posted_at, created_at) where last_posted_at is null;
update public.residential_rent_listings set last_posted_at = coalesce(last_posted_at, created_at) where last_posted_at is null;
update public.commercial_sale_listings set last_posted_at = coalesce(last_posted_at, created_at) where last_posted_at is null;
update public.commercial_rent_listings set last_posted_at = coalesce(last_posted_at, created_at) where last_posted_at is null;
