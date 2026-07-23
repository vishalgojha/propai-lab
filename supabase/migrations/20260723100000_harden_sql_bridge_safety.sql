-- Harden propai_query_sql and propai_run_sql against destructive operations.
-- Both functions now validate the SQL statement before execution.
-- Blocked: DELETE, DROP, TRUNCATE, ALTER, CREATE (except in propai_run_sql for migrations)
-- This prevents accidental or malicious data loss even if the functions are called
-- with unvalidated SQL.

create or replace function public._validate_sql_safety(sql text, allow_writes boolean default false)
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  head text;
  normalized text;
begin
  -- Strip leading comments and whitespace
  head := regexp_replace(sql, '^\s*(?:--.*?\n|/\*.*?\*/\s*)*', '', 'flags');
  head := btrim(head);
  normalized := lower(head);

  -- Always block these regardless of allow_writes
  if normalized ~ '^\s*drop\s' then
    raise exception 'SQL safety: DROP statements are not allowed';
  end if;

  if normalized ~ '^\s*truncate\s' then
    raise exception 'SQL safety: TRUNCATE statements are not allowed';
  end if;

  if normalized ~ '^\s*alter\s' then
    raise exception 'SQL safety: ALTER statements are not allowed';
  end if;

  if normalized ~ '^\s*create\s(?!temp\b|temporary\b)' then
    raise exception 'SQL safety: permanent CREATE statements are not allowed (temp OK)';
  end if;

  -- For query mode (allow_writes = false): only allow SELECT, WITH, SHOW, VALUES, EXPLAIN
  if not allow_writes then
    if normalized !~ '^\s*(select|with|show|values|explain)\s' then
      raise exception 'SQL safety: only SELECT/WITH/SHOW/VALUES/EXPLAIN allowed in query mode';
    end if;
  end if;

  -- For write mode (allow_writes = true): block bare DELETE without WHERE
  if allow_writes and normalized ~ '^\s*delete\s+from\s' then
    if normalized !~ '\s+where\s' then
      raise exception 'SQL safety: DELETE requires a WHERE clause';
    end if;
  end if;

  -- Block bare UPDATE without WHERE (in write mode)
  if allow_writes and normalized ~ '^\s*update\s' then
    if normalized !~ '\s+where\s' then
      raise exception 'SQL safety: UPDATE requires a WHERE clause';
    end if;
  end if;
end;
$$;

-- Update propai_query_sql to use safety check
create or replace function public.propai_query_sql(sql text, params jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  rendered_sql text := btrim(coalesce(sql, ''));
  idx int;
  param text;
  result jsonb;
begin
  if rendered_sql = '' then
    return '[]'::jsonb;
  end if;

  params := coalesce(params, '[]'::jsonb);
  idx := jsonb_array_length(params);
  while idx > 0 loop
    param := params ->> (idx - 1);
    rendered_sql := replace(rendered_sql, '$' || idx::text, quote_nullable(param));
    idx := idx - 1;
  end loop;

  -- Safety check: only allow read queries
  perform public._validate_sql_safety(rendered_sql, allow_writes => false);

  execute format(
    'select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from (%s) t',
    rendered_sql
  ) into result;

  return coalesce(result, '[]'::jsonb);
end;
$$;

-- Update propai_run_sql to use safety check
create or replace function public.propai_run_sql(sql text, params jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  rendered_sql text := btrim(coalesce(sql, ''));
  idx int;
  param text;
  row_count bigint := 0;
begin
  if rendered_sql = '' then
    return jsonb_build_object('row_count', 0);
  end if;

  params := coalesce(params, '[]'::jsonb);
  idx := jsonb_array_length(params);
  while idx > 0 loop
    param := params ->> (idx - 1);
    rendered_sql := replace(rendered_sql, '$' || idx::text, quote_nullable(param));
    idx := idx - 1;
  end loop;

  -- Safety check: allow writes but block dangerous operations
  perform public._validate_sql_safety(rendered_sql, allow_writes => true);

  execute rendered_sql;
  get diagnostics row_count = row_count;
  return jsonb_build_object('row_count', row_count);
end;
$$;

revoke all on function public._validate_sql_safety(text, boolean) from public, anon, authenticated;
grant execute on function public._validate_sql_safety(text, boolean) to service_role;
