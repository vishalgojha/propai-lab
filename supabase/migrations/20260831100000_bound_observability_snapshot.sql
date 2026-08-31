-- Keep the read-only super-admin snapshot from being cancelled by the short
-- PostgREST statement timeout while its exact quality checks finish. The
-- underlying function remains unchanged; this wrapper only changes the local
-- timeout for this bounded, service-role-only diagnostic call.
create or replace function public.admin_supabase_observability_bounded()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  perform set_config('statement_timeout', '25000', true);
  return public.admin_supabase_observability();
end;
$$;

revoke all on function public.admin_supabase_observability_bounded() from public, anon, authenticated;
grant execute on function public.admin_supabase_observability_bounded() to service_role;

-- The snapshot's duplicate-key audit groups by both columns. These indexes
-- make that exact check index-friendly without changing any source rows.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'residential_sale_listings',
    'residential_rent_listings',
    'commercial_sale_listings',
    'commercial_rent_listings',
    'residential_sale_requirements',
    'residential_rent_requirements',
    'commercial_sale_requirements',
    'commercial_rent_requirements'
  ] loop
    execute format(
      'create index if not exists %I on public.%I (tenant_id, raw_message_id) where raw_message_id is not null',
      table_name || '_observability_source_idx', table_name
    );
  end loop;
end $$;
