-- ============================================================================
-- Supabase security hardening
-- ============================================================================
-- Remove overbroad access to internal RPCs, pin search_path on mutable functions,
-- and tighten LLM provider table access to service-role only.
-- ============================================================================

-- ── Internal SQL bridge: service-role only ──────────────────────────────────
create or replace function public.propai_query_sql(sql text, params jsonb default '[]'::jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
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
set search_path = public, pg_temp
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

revoke all on function public.propai_query_sql(text, jsonb) from public, anon, authenticated;
revoke all on function public.propai_run_sql(text, jsonb) from public, anon, authenticated;
grant execute on function public.propai_query_sql(text, jsonb) to service_role;
grant execute on function public.propai_run_sql(text, jsonb) to service_role;

-- ── Mutable search_path functions ───────────────────────────────────────────
create or replace function public.trigger_set_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

create or replace function public.auto_assign_tenant_raw_message()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
    v_org_id uuid;
    v_instance text;
begin
    if NEW.tenant_id is not null then
        return NEW;
    end if;

    v_instance := coalesce(
        NEW.raw_payload->>'instance',
        NEW.raw_payload #>> '{data,instance}'
    );

    select organization_id into v_org_id
    from org_whatsapp_connections
    where (NEW.sender_phone is not null and NEW.sender_phone <> '' and phone_number = NEW.sender_phone)
       or (v_instance is not null and v_instance <> '' and instance_name = v_instance)
    limit 1;

    if v_org_id is null and exists (
        select 1 from organizations where id = '00000000-0000-0000-0000-000000000010'::uuid
    ) then
        v_org_id := '00000000-0000-0000-0000-000000000010'::uuid;
    end if;

    if v_org_id is not null then
        NEW.tenant_id = v_org_id;
    end if;

    return NEW;
end;
$$;

create or replace function public.propagate_tenant_parsed_output()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
    select tenant_id into NEW.tenant_id
    from raw_messages where id = NEW.raw_message_id;
    return NEW;
end;
$$;

create or replace function public.propagate_tenant_observations()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
    select tenant_id into NEW.tenant_id
    from raw_messages where id = NEW.raw_message_id;
    return NEW;
end;
$$;

create or replace function public.seed_system_roles()
returns void
language plpgsql
set search_path = public, pg_temp
as $$
declare
    v_owner_id bigint;
    v_admin_id bigint;
    v_broker_id bigint;
    v_analyst_id bigint;
    v_viewer_id bigint;
begin
    insert into roles (organization_id, name, slug, description, is_system)
    values
        (null, 'Owner',    'owner',    'Full access to everything in the workspace', true),
        (null, 'Admin',    'admin',    'Administrative access to most features', true),
        (null, 'Broker',   'broker',   'Day-to-day broker operations', true),
        (null, 'Analyst',  'analyst',  'Market analysis and reporting', true),
        (null, 'Viewer',   'viewer',   'Read-only access to the workspace', true)
    on conflict (organization_id, slug) do nothing;

    select id into v_owner_id from roles where slug = 'owner' and organization_id is null;
    select id into v_admin_id from roles where slug = 'admin' and organization_id is null;
    select id into v_broker_id from roles where slug = 'broker' and organization_id is null;
    select id into v_analyst_id from roles where slug = 'analyst' and organization_id is null;
    select id into v_viewer_id from roles where slug = 'viewer' and organization_id is null;

    insert into role_permissions (role_id, permission_id)
    select v_owner_id, id from permissions
    on conflict do nothing;

    insert into role_permissions (role_id, permission_id)
    select v_admin_id, id from permissions
    where key not in ('delete_workspace', 'manage_billing')
    on conflict do nothing;

    insert into role_permissions (role_id, permission_id)
    select v_broker_id, id from permissions
    where key in ('view_inbox', 'reply_whatsapp', 'view_market', 'manage_whatsapp', 'manage_groups')
    on conflict do nothing;

    insert into role_permissions (role_id, permission_id)
    select v_analyst_id, id from permissions
    where key in ('view_inbox', 'view_market', 'view_reports', 'export_data')
    on conflict do nothing;

    insert into role_permissions (role_id, permission_id)
    select v_viewer_id, id from permissions
    where key in ('view_inbox', 'view_market')
    on conflict do nothing;
end;
$$;

-- ── Lock down LLM providers to backend-only access ─────────────────────────
drop policy if exists "authenticated select" on llm_providers;
drop policy if exists "authenticated all" on llm_providers;
