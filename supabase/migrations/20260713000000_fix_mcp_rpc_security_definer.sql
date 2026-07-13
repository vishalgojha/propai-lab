-- ============================================================================
-- Fix propai_query_sql and propai_run_sql to run as SECURITY DEFINER
-- ============================================================================
-- These functions were SECURITY INVOKER (default), meaning they ran with the
-- caller's permissions (anon/user JWT). After the multi-tenant RLS migration,
-- this caused all tenant-scoped table queries to return 0 rows for non-service-role
-- callers. Making them SECURITY DEFINER makes them run with the function owner's
-- permissions (service_role), bypassing RLS for internal diagnostic/admin queries.
-- ============================================================================

-- Drop and recreate propai_query_sql with SECURITY DEFINER
drop function if exists public.propai_query_sql(sql text, params jsonb);

create function public.propai_query_sql(sql text, params jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
as $$
declare
  rendered_sql text := btrim(coalesce(sql, ''));
  idx int := 0;
  param text;
  result jsonb;
begin
  if rendered_sql = '' then
    return '[]'::jsonb;
  end if;

  if params is null then
    params := '[]'::jsonb;
  end if;

  for param in
    select value::text
    from jsonb_array_elements_text(params)
  loop
    idx := idx + 1;
    rendered_sql := replace(rendered_sql, '$' || idx::text, quote_nullable(param));
  end loop;

  execute format(
    'select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from (%s) t',
    rendered_sql
  ) into result;

  return coalesce(result, '[]'::jsonb);
end;
$$;

-- Drop and recreate propai_run_sql with SECURITY DEFINER
drop function if exists public.propai_run_sql(sql text, params jsonb);

create function public.propai_run_sql(sql text, params jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security definer
as $$
declare
  rendered_sql text := btrim(coalesce(sql, ''));
  idx int := 0;
  param text;
  row_count bigint := 0;
begin
  if rendered_sql = '' then
    return jsonb_build_object('row_count', 0);
  end if;

  if params is null then
    params := '[]'::jsonb;
  end if;

  for param in
    select value::text
    from jsonb_array_elements_text(params)
  loop
    idx := idx + 1;
    rendered_sql := replace(rendered_sql, '$' || idx::text, quote_nullable(param));
  end loop;

  execute rendered_sql;
  get diagnostics row_count = row_count;
  return jsonb_build_object('row_count', row_count);
end;
$$;

-- Grant execute to service_role and authenticated (for backward compatibility)
grant execute on function public.propai_query_sql(text, jsonb) to service_role, authenticated;
grant execute on function public.propai_run_sql(text, jsonb) to service_role, authenticated;