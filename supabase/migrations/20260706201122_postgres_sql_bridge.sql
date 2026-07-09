-- Supabase-native SQL bridge for internal server-side use.
-- This lets the backend execute Postgres SQL against Supabase without any local SQLite file.

create or replace function public.propai_query_sql(sql text, params jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
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

create or replace function public.propai_run_sql(sql text, params jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions
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

create or replace function public.strftime(format text, value text)
returns text
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
  ts timestamptz;
begin
  if value is null or btrim(value) = '' then
    return null;
  end if;

  if lower(btrim(value)) = 'now' then
    ts := timezone('utc', now());
  else
    begin
      ts := value::timestamptz;
    exception when others then
      begin
        ts := to_timestamp(value, 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
      exception when others then
        return value;
      end;
    end;
  end if;

  if format = '%s' then
    return floor(extract(epoch from ts))::bigint::text;
  end if;

  if format = '%Y-%m-%d' then
    return to_char(ts at time zone 'UTC', 'YYYY-MM-DD');
  end if;

  if format = '%Y-%m-%dT%H:%M:%SZ' then
    return to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  end if;

  return to_char(ts at time zone 'UTC', format);
end;
$$;

revoke all on function public.propai_query_sql(text, jsonb) from public;
revoke all on function public.propai_run_sql(text, jsonb) from public;
revoke all on function public.strftime(text, text) from public;
grant execute on function public.propai_query_sql(text, jsonb) to service_role;
grant execute on function public.propai_run_sql(text, jsonb) to service_role;
grant execute on function public.strftime(text, text) to service_role;
