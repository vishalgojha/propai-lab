-- The SQL bridge used to substitute $1 before $10/$11/$12. That changed
-- multi-digit placeholders into invalid fragments such as 'value'0 and broke
-- every adapter write with ten or more parameters (including WABA messages).
-- Replace from the highest parameter number down so placeholders cannot
-- partially overlap.

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

  execute rendered_sql;
  get diagnostics row_count = row_count;
  return jsonb_build_object('row_count', row_count);
end;
$$;

revoke all on function public.propai_query_sql(text, jsonb) from public, anon, authenticated;
revoke all on function public.propai_run_sql(text, jsonb) from public, anon, authenticated;
grant execute on function public.propai_query_sql(text, jsonb) to service_role;
grant execute on function public.propai_run_sql(text, jsonb) to service_role;

-- Meta retries webhook events. Keep one inbound row per Meta message ID so
-- retries cannot trigger duplicate agent replies.
create unique index if not exists idx_raw_messages_waba_inbound_uid_unique
    on public.raw_messages (message_uid)
    where source = 'WABA_INBOUND' and message_uid is not null;
