-- ============================================================================
-- Live tenant isolation repair.
-- Use this after confirming the project does not have the auth.* RBAC helpers.
-- Do not create application helpers in Supabase reserved schemas.
-- ============================================================================

create schema if not exists app_private;

create or replace function app_private.user_tenant_ids()
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  select organization_id
  from public.organization_members
  where user_id = auth.uid()
    and is_active = true;
$$;

create or replace function app_private.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.super_admins
    where user_id = auth.uid()
  );
$$;

create or replace function app_private.user_permissions()
returns table(key text)
language sql
stable
security definer
set search_path = public
as $$
  select distinct p.key
  from public.organization_members om
  join public.role_permissions rp on rp.role_id = om.role_id
  join public.permissions p on p.id = rp.permission_id
  where om.user_id = auth.uid()
    and om.is_active = true;
$$;

revoke all on schema app_private from public;
grant usage on schema app_private to authenticated, service_role;

revoke all on function app_private.user_tenant_ids() from public;
revoke all on function app_private.is_super_admin() from public;
revoke all on function app_private.user_permissions() from public;
grant execute on function app_private.user_tenant_ids() to authenticated, service_role;
grant execute on function app_private.is_super_admin() to authenticated, service_role;
grant execute on function app_private.user_permissions() to authenticated, service_role;

do $$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000010';
begin
  if not exists (select 1 from public.organizations where id = default_tenant) then
    raise exception 'Default tenant % does not exist', default_tenant;
  end if;

  create table if not exists public.ai_chat_sessions (
    id uuid primary key default gen_random_uuid(),
    broker_phone text not null,
    title text not null default 'New chat',
    tenant_id uuid references public.organizations(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );

  create table if not exists public.ai_chat_messages (
    id uuid primary key default gen_random_uuid(),
    session_id uuid not null references public.ai_chat_sessions(id) on delete cascade,
    role text not null check (role in ('user', 'assistant', 'system')),
    content text not null,
    tenant_id uuid references public.organizations(id),
    created_at timestamptz not null default now()
  );

  alter table public.ai_chat_sessions add column if not exists tenant_id uuid references public.organizations(id);
  alter table public.ai_chat_messages add column if not exists tenant_id uuid references public.organizations(id);
  alter table public.user_profiles add column if not exists tenant_id uuid references public.organizations(id);
  alter table public.saved_inbox_views add column if not exists tenant_id uuid references public.organizations(id);
  alter table public.llm_providers add column if not exists tenant_id uuid references public.organizations(id);

  update public.raw_messages set tenant_id = default_tenant where tenant_id is null;
  update public.parsed_output set tenant_id = default_tenant where tenant_id is null;
  update public.listings set tenant_id = default_tenant where tenant_id is null;
  update public.brokers set tenant_id = default_tenant where tenant_id is null;
  update public.clients set tenant_id = default_tenant where tenant_id is null;
  update public.client_requirements set tenant_id = default_tenant where tenant_id is null;
  update public.saved_inbox_views set tenant_id = default_tenant where tenant_id is null;
  update public.user_profiles set tenant_id = default_tenant where tenant_id is null;
  update public.llm_providers set tenant_id = default_tenant where tenant_id is null;
  update public.ai_chat_sessions set tenant_id = default_tenant where tenant_id is null;
  update public.ai_chat_messages set tenant_id = default_tenant where tenant_id is null;

  alter table public.raw_messages alter column tenant_id set not null;
  alter table public.parsed_output alter column tenant_id set not null;
  alter table public.listings alter column tenant_id set not null;
  alter table public.brokers alter column tenant_id set not null;
  alter table public.clients alter column tenant_id set not null;
  alter table public.client_requirements alter column tenant_id set not null;
  alter table public.saved_inbox_views alter column tenant_id set not null;
  alter table public.user_profiles alter column tenant_id set not null;
  alter table public.llm_providers alter column tenant_id set not null;
  alter table public.ai_chat_sessions alter column tenant_id set not null;
  alter table public.ai_chat_messages alter column tenant_id set not null;

  create index if not exists idx_raw_messages_tenant on public.raw_messages(tenant_id);
  create index if not exists idx_parsed_output_tenant on public.parsed_output(tenant_id);
  create index if not exists idx_listings_tenant on public.listings(tenant_id);
  create index if not exists idx_brokers_tenant on public.brokers(tenant_id);
  create index if not exists idx_clients_tenant on public.clients(tenant_id);
  create index if not exists idx_client_requirements_tenant on public.client_requirements(tenant_id);
  create index if not exists idx_saved_inbox_views_tenant on public.saved_inbox_views(tenant_id);
  create index if not exists idx_user_profiles_tenant on public.user_profiles(tenant_id);
  create index if not exists idx_llm_providers_tenant on public.llm_providers(tenant_id);
  create index if not exists idx_ai_chat_sessions_tenant on public.ai_chat_sessions(tenant_id);
  create index if not exists idx_ai_chat_messages_tenant on public.ai_chat_messages(tenant_id);
  create index if not exists ai_chat_sessions_broker_phone_idx on public.ai_chat_sessions(broker_phone, updated_at desc);
  create index if not exists ai_chat_messages_session_id_idx on public.ai_chat_messages(session_id, created_at);
end $$;

drop policy if exists "authenticated all" on public.llm_providers;
drop policy if exists "authenticated select" on public.llm_providers;
drop policy if exists "service_role all" on public.llm_providers;
drop policy if exists "Service role has full access to user_profiles" on public.user_profiles;

do $$
declare
  tbl text;
  tenant_tables text[] := array[
    'raw_messages', 'parsed_output', 'listings', 'brokers',
    'broker_phones', 'broker_aliases', 'broker_observations',
    'broker_market_stats', 'broker_building_stats',
    'clients', 'client_requirements', 'client_property_candidates',
    'buildings', 'building_name_aliases', 'listing_observations',
    'knowledge_records', 'knowledge_tags', 'knowledge_aliases',
    'knowledge_observations', 'knowledge_trainer',
    'ai_suggestions', 'ai_usage_log', 'evaluations',
    'observations', 'observation_evidence', 'observation_batches',
    'resolver_decisions', 'listing_photos', 'saved_inbox_views',
    'requirement_matches', 'follow_ups', 'enrichment_jobs',
    'building_enrichment_jobs', 'whatsapp_events',
    'ai_chat_sessions', 'ai_chat_messages',
    'user_profiles', 'llm_providers'
  ];
begin
  foreach tbl in array tenant_tables loop
    if to_regclass(format('public.%I', tbl)) is null then
      continue;
    end if;

    execute format('alter table public.%I enable row level security;', tbl);

    execute format('drop policy if exists "tenant_select_%I" on public.%I;', tbl, tbl);
    execute format(
      'create policy "tenant_select_%I" on public.%I for select to authenticated using (
        app_private.is_super_admin() or tenant_id = any(select app_private.user_tenant_ids())
      );',
      tbl, tbl
    );

    execute format('drop policy if exists "tenant_insert_%I" on public.%I;', tbl, tbl);
    execute format(
      'create policy "tenant_insert_%I" on public.%I for insert to authenticated with check (
        app_private.is_super_admin() or tenant_id = any(select app_private.user_tenant_ids())
      );',
      tbl, tbl
    );

    execute format('drop policy if exists "tenant_update_%I" on public.%I;', tbl, tbl);
    execute format(
      'create policy "tenant_update_%I" on public.%I for update to authenticated using (
        app_private.is_super_admin() or tenant_id = any(select app_private.user_tenant_ids())
      ) with check (
        app_private.is_super_admin() or tenant_id = any(select app_private.user_tenant_ids())
      );',
      tbl, tbl
    );

    execute format('drop policy if exists "tenant_delete_%I" on public.%I;', tbl, tbl);
    execute format(
      'create policy "tenant_delete_%I" on public.%I for delete to authenticated using (
        app_private.is_super_admin() or tenant_id = any(select app_private.user_tenant_ids())
      );',
      tbl, tbl
    );

    execute format('drop policy if exists "service_role_all_%I" on public.%I;', tbl, tbl);
    execute format(
      'create policy "service_role_all_%I" on public.%I for all to service_role using (true) with check (true);',
      tbl, tbl
    );
  end loop;
end $$;

alter table public.organizations enable row level security;
drop policy if exists "org_select" on public.organizations;
create policy "org_select" on public.organizations for select to authenticated using (
  app_private.is_super_admin() or id = any(select app_private.user_tenant_ids())
);
drop policy if exists "org_insert" on public.organizations;
create policy "org_insert" on public.organizations for insert to authenticated with check (
  app_private.is_super_admin()
);
drop policy if exists "org_update" on public.organizations;
create policy "org_update" on public.organizations for update to authenticated using (
  app_private.is_super_admin() or id = any(select app_private.user_tenant_ids())
) with check (
  app_private.is_super_admin() or id = any(select app_private.user_tenant_ids())
);
drop policy if exists "org_delete" on public.organizations;
create policy "org_delete" on public.organizations for delete to authenticated using (
  app_private.is_super_admin()
);
drop policy if exists "service_role_all_organizations" on public.organizations;
create policy "service_role_all_organizations" on public.organizations for all to service_role using (true) with check (true);

alter table public.organization_members enable row level security;
drop policy if exists "org_members_select" on public.organization_members;
create policy "org_members_select" on public.organization_members for select to authenticated using (
  app_private.is_super_admin() or user_id = auth.uid() or organization_id = any(select app_private.user_tenant_ids())
);
drop policy if exists "org_members_insert" on public.organization_members;
create policy "org_members_insert" on public.organization_members for insert to authenticated with check (
  app_private.is_super_admin() or organization_id = any(select app_private.user_tenant_ids())
);
drop policy if exists "org_members_update" on public.organization_members;
create policy "org_members_update" on public.organization_members for update to authenticated using (
  app_private.is_super_admin() or organization_id = any(select app_private.user_tenant_ids())
) with check (
  app_private.is_super_admin() or organization_id = any(select app_private.user_tenant_ids())
);
drop policy if exists "org_members_delete" on public.organization_members;
create policy "org_members_delete" on public.organization_members for delete to authenticated using (
  app_private.is_super_admin() or organization_id = any(select app_private.user_tenant_ids())
);
drop policy if exists "service_role_all_organization_members" on public.organization_members;
create policy "service_role_all_organization_members" on public.organization_members for all to service_role using (true) with check (true);

alter table public.super_admins enable row level security;
drop policy if exists "super_admins_select" on public.super_admins;
create policy "super_admins_select" on public.super_admins for select to authenticated using (
  app_private.is_super_admin()
);
drop policy if exists "super_admins_insert" on public.super_admins;
create policy "super_admins_insert" on public.super_admins for insert to authenticated with check (
  app_private.is_super_admin()
);
drop policy if exists "super_admins_update" on public.super_admins;
create policy "super_admins_update" on public.super_admins for update to authenticated using (
  app_private.is_super_admin()
) with check (
  app_private.is_super_admin()
);
drop policy if exists "super_admins_delete" on public.super_admins;
create policy "super_admins_delete" on public.super_admins for delete to authenticated using (
  app_private.is_super_admin()
);
drop policy if exists "service_role_all_super_admins" on public.super_admins;
create policy "service_role_all_super_admins" on public.super_admins for all to service_role using (true) with check (true);

alter table public.roles enable row level security;
drop policy if exists "roles_select" on public.roles;
create policy "roles_select" on public.roles for select to authenticated using (
  app_private.is_super_admin() or organization_id is null or organization_id = any(select app_private.user_tenant_ids())
);
drop policy if exists "roles_insert" on public.roles;
create policy "roles_insert" on public.roles for insert to authenticated with check (app_private.is_super_admin());
drop policy if exists "roles_update" on public.roles;
create policy "roles_update" on public.roles for update to authenticated using (app_private.is_super_admin()) with check (app_private.is_super_admin());
drop policy if exists "roles_delete" on public.roles;
create policy "roles_delete" on public.roles for delete to authenticated using (app_private.is_super_admin());
drop policy if exists "service_role_all_roles" on public.roles;
create policy "service_role_all_roles" on public.roles for all to service_role using (true) with check (true);

alter table public.role_permissions enable row level security;
drop policy if exists "role_permissions_select" on public.role_permissions;
create policy "role_permissions_select" on public.role_permissions for select to authenticated using (
  app_private.is_super_admin() or exists (
    select 1 from public.roles r
    where r.id = role_permissions.role_id
      and (r.organization_id is null or r.organization_id = any(select app_private.user_tenant_ids()))
  )
);
drop policy if exists "role_permissions_insert" on public.role_permissions;
create policy "role_permissions_insert" on public.role_permissions for insert to authenticated with check (app_private.is_super_admin());
drop policy if exists "role_permissions_update" on public.role_permissions;
create policy "role_permissions_update" on public.role_permissions for update to authenticated using (app_private.is_super_admin()) with check (app_private.is_super_admin());
drop policy if exists "role_permissions_delete" on public.role_permissions;
create policy "role_permissions_delete" on public.role_permissions for delete to authenticated using (app_private.is_super_admin());
drop policy if exists "service_role_all_role_permissions" on public.role_permissions;
create policy "service_role_all_role_permissions" on public.role_permissions for all to service_role using (true) with check (true);

alter table public.permissions enable row level security;
drop policy if exists "perms_select" on public.permissions;
create policy "perms_select" on public.permissions for select to authenticated using (true);
drop policy if exists "perms_insert" on public.permissions;
create policy "perms_insert" on public.permissions for insert to authenticated with check (app_private.is_super_admin());
drop policy if exists "perms_update" on public.permissions;
create policy "perms_update" on public.permissions for update to authenticated using (app_private.is_super_admin()) with check (app_private.is_super_admin());
drop policy if exists "perms_delete" on public.permissions;
create policy "perms_delete" on public.permissions for delete to authenticated using (app_private.is_super_admin());
drop policy if exists "service_role_all_permissions" on public.permissions;
create policy "service_role_all_permissions" on public.permissions for all to service_role using (true) with check (true);

