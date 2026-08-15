-- Requirements can be reposted or repeated just like supply listings, but
-- they must remain reviewable source records until the broker explicitly
-- chooses to merge them. This adds the same candidate-review metadata used by
-- the listing repost workflow without auto-merging demand.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'residential_sale_requirements',
    'residential_rent_requirements',
    'commercial_sale_requirements',
    'commercial_rent_requirements'
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
    execute format('create index if not exists %I on public.%I (tenant_id, duplicate_status, last_posted_at desc)', table_name || '_duplicates_idx', table_name);
    execute format('update public.%I set last_posted_at = coalesce(last_posted_at, created_at) where last_posted_at is null', table_name);
  end loop;
end $$;
