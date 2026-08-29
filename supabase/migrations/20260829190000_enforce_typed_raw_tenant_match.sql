-- A typed listing/requirement belongs to the same workspace as its source
-- raw message. Shared-market visibility is represented by visibility/source
-- scope; it is never created by assigning a typed row to another tenant.

create or replace function public.enforce_typed_raw_tenant_match()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  source_tenant uuid;
begin
  select tenant_id into source_tenant
  from public.raw_messages
  where id = new.raw_message_id;

  if new.tenant_id is not null
     and source_tenant is not null
     and new.tenant_id is distinct from source_tenant then
    raise exception using
      errcode = '23514',
      message = format(
        'typed row tenant_id must match raw_messages tenant_id (table=%s, raw_message_id=%s)',
        tg_table_name,
        new.raw_message_id
      );
  end if;

  return new;
end;
$$;

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
      'drop trigger if exists trg_%s_raw_tenant_match on public.%I',
      table_name,
      table_name
    );
    execute format(
      'create trigger trg_%s_raw_tenant_match before insert or update of raw_message_id, tenant_id on public.%I for each row execute function public.enforce_typed_raw_tenant_match()',
      table_name,
      table_name
    );
  end loop;
end;
$$;

revoke all on function public.enforce_typed_raw_tenant_match() from public, anon, authenticated;
grant execute on function public.enforce_typed_raw_tenant_match() to service_role;
