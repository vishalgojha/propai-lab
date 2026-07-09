-- ============================================================================
-- Multi-Tenant + RBAC + Super Admin
-- ============================================================================

-- ── Organizations ────────────────────────────────────────────────────────────
create table if not exists organizations (
    id              uuid primary key default gen_random_uuid(),
    name            text not null,
    slug            text not null unique,
    is_active       boolean not null default true,
    privacy_mode    text not null default 'private' check (privacy_mode in ('private', 'shared')),
    share_listings      boolean not null default false,
    share_requirements  boolean not null default false,
    share_price_trends  boolean not null default false,
    share_market_activity boolean not null default false,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

-- ── Organization Members ─────────────────────────────────────────────────────
create table if not exists organization_members (
    id              bigint generated always as identity primary key,
    organization_id uuid not null references organizations(id) on delete cascade,
    user_id         uuid not null references auth.users(id) on delete cascade,
    role_id         bigint,
    is_active       boolean not null default true,
    created_at      timestamptz not null default now(),
    unique(organization_id, user_id)
);

create index idx_org_members_org on organization_members(organization_id);
create index idx_org_members_user on organization_members(user_id);

-- ── Roles ────────────────────────────────────────────────────────────────────
create table if not exists roles (
    id              bigint generated always as identity primary key,
    organization_id uuid references organizations(id) on delete cascade,
    name            text not null,
    slug            text not null,
    description     text default '',
    is_system       boolean not null default false,
    created_at      timestamptz not null default now(),
    unique(organization_id, slug)
);

-- ── Permissions ──────────────────────────────────────────────────────────────
create table if not exists permissions (
    id              bigint generated always as identity primary key,
    key             text not null unique,
    label           text not null,
    description     text default '',
    category        text default '',
    created_at      timestamptz not null default now()
);

-- ── Role Permissions ─────────────────────────────────────────────────────────
create table if not exists role_permissions (
    role_id         bigint not null references roles(id) on delete cascade,
    permission_id   bigint not null references permissions(id) on delete cascade,
    created_at      timestamptz not null default now(),
    primary key (role_id, permission_id)
);

-- ── Super Admins ─────────────────────────────────────────────────────────────
create table if not exists super_admins (
    id              bigint generated always as identity primary key,
    user_id         uuid not null references auth.users(id) on delete cascade unique,
    phone           text,
    email           text,
    created_at      timestamptz not null default now()
);

-- ── Organization WhatsApp Connections ────────────────────────────────────────
create table if not exists org_whatsapp_connections (
    id              bigint generated always as identity primary key,
    organization_id uuid not null references organizations(id) on delete cascade,
    phone_number    text not null,
    instance_name   text default '',
    waba_id         text default '',
    is_active       boolean not null default true,
    connected_at    timestamptz not null default now(),
    created_at      timestamptz not null default now(),
    unique(organization_id, phone_number)
);

create index idx_org_whatsapp_org on org_whatsapp_connections(organization_id);

-- ── Add tenant_id to existing tables ─────────────────────────────────────────

-- raw_messages
alter table raw_messages add column if not exists tenant_id uuid references organizations(id);

-- parsed_output (inherits tenant from raw_message)
alter table parsed_output add column if not exists tenant_id uuid references organizations(id);

-- listings
alter table listings add column if not exists tenant_id uuid references organizations(id);

-- brokers
alter table brokers add column if not exists tenant_id uuid references organizations(id);

-- broker_phones
alter table broker_phones add column if not exists tenant_id uuid references organizations(id);

-- broker_aliases
alter table broker_aliases add column if not exists tenant_id uuid references organizations(id);

-- broker_observations
alter table broker_observations add column if not exists tenant_id uuid references organizations(id);

-- broker_market_stats
alter table broker_market_stats add column if not exists tenant_id uuid references organizations(id);

-- broker_building_stats
alter table broker_building_stats add column if not exists tenant_id uuid references organizations(id);

-- clients
alter table clients add column if not exists tenant_id uuid references organizations(id);

-- client_requirements
alter table client_requirements add column if not exists tenant_id uuid references organizations(id);

-- client_property_candidates
alter table client_property_candidates add column if not exists tenant_id uuid references organizations(id);

-- buildings
alter table buildings add column if not exists tenant_id uuid references organizations(id);

-- building_name_aliases
alter table building_name_aliases add column if not exists tenant_id uuid references organizations(id);

-- listing_observations
alter table listing_observations add column if not exists tenant_id uuid references organizations(id);

-- knowledge_records
alter table knowledge_records add column if not exists tenant_id uuid references organizations(id);

-- knowledge_tags
alter table knowledge_tags add column if not exists tenant_id uuid references organizations(id);

-- knowledge_aliases
alter table knowledge_aliases add column if not exists tenant_id uuid references organizations(id);

-- knowledge_observations
alter table knowledge_observations add column if not exists tenant_id uuid references organizations(id);

-- knowledge_trainer
alter table knowledge_trainer add column if not exists tenant_id uuid references organizations(id);

-- ai_suggestions
alter table ai_suggestions add column if not exists tenant_id uuid references organizations(id);

-- ai_usage_log
alter table ai_usage_log add column if not exists tenant_id uuid references organizations(id);

-- evaluations
alter table evaluations add column if not exists tenant_id uuid references organizations(id);

-- observations
alter table observations add column if not exists tenant_id uuid references organizations(id);

-- observation_evidence
alter table observation_evidence add column if not exists tenant_id uuid references organizations(id);

-- observation_batches
alter table observation_batches add column if not exists tenant_id uuid references organizations(id);

-- resolver_decisions
alter table resolver_decisions add column if not exists tenant_id uuid references organizations(id);

-- listing_photos
alter table listing_photos add column if not exists tenant_id uuid references organizations(id);

-- saved_inbox_views
alter table saved_inbox_views add column if not exists tenant_id uuid references organizations(id);

-- requirement_matches
alter table requirement_matches add column if not exists tenant_id uuid references organizations(id);

-- follow_ups
alter table follow_ups add column if not exists tenant_id uuid references organizations(id);

-- enrichment_jobs
alter table enrichment_jobs add column if not exists tenant_id uuid references organizations(id);

-- building_enrichment_jobs
alter table building_enrichment_jobs add column if not exists tenant_id uuid references organizations(id);

-- ── Indexes for tenant_id ────────────────────────────────────────────────────
do $$
declare
    tables_with_tenant text[] := array[
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
        'building_enrichment_jobs'
    ];
    tbl text;
begin
    foreach tbl in array tables_with_tenant
    loop
        execute format('create index if not exists idx_%I_tenant on %I(tenant_id);', tbl, tbl);
    end loop;
end $$;

-- ============================================================================
-- RLS Policies — Tenant Isolation
-- ============================================================================

-- Drop old permissive policies
do $$
declare
    tbl text;
    pol text;
begin
    for tbl in
        select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
    loop
        for pol in
            select policyname from pg_policies
            where tablename = tbl and schemaname = 'public'
              and (policyname like 'authenticated_select_%' or policyname like 'authenticated_insert_%'
                or policyname like 'authenticated_update_%' or policyname like 'authenticated_delete_%')
        loop
            execute format('drop policy if exists %I on %I;', pol, tbl);
        end loop;
    end loop;
end $$;

-- ── Helper function: get user's tenant IDs ───────────────────────────────────
create or replace function auth.user_tenant_ids()
returns setof uuid
language sql
stable
as $$
    select organization_id
    from public.organization_members
    where user_id = auth.uid()
      and is_active = true;
$$;

-- ── Helper function: check if user is super admin ────────────────────────────
create or replace function auth.is_super_admin()
returns boolean
language sql
stable
as $$
    select exists (
        select 1 from public.super_admins
        where user_id = auth.uid()
    );
$$;

-- ── Helper function: get user's role permissions ─────────────────────────────
create or replace function auth.user_permissions()
returns table(key text)
language sql
stable
as $$
    select distinct p.key
    from public.organization_members om
    join public.role_permissions rp on rp.role_id = om.role_id
    join public.permissions p on p.id = rp.permission_id
    where om.user_id = auth.uid()
      and om.is_active = true;
$$;

-- ── Tenant RLS for tables that have tenant_id ────────────────────────────────
-- Super admins bypass tenant RLS; regular users are scoped to their orgs.

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
        'building_enrichment_jobs',
        'organization_members', 'org_whatsapp_connections'
    ];
begin
    foreach tbl in array tenant_tables
    loop
        execute format(
            'create policy "tenant_select_%I" on %I for select using (
                auth.is_super_admin() or
                tenant_id = any(select auth.user_tenant_ids())
            );',
            tbl, tbl
        );
        execute format(
            'create policy "tenant_insert_%I" on %I for insert with check (
                auth.is_super_admin() or
                tenant_id = any(select auth.user_tenant_ids())
            );',
            tbl, tbl
        );
        execute format(
            'create policy "tenant_update_%I" on %I for update using (
                auth.is_super_admin() or
                tenant_id = any(select auth.user_tenant_ids())
            ) with check (
                auth.is_super_admin() or
                tenant_id = any(select auth.user_tenant_ids())
            );',
            tbl, tbl
        );
        execute format(
            'create policy "tenant_delete_%I" on %I for delete using (
                auth.is_super_admin() or
                tenant_id = any(select auth.user_tenant_ids())
            );',
            tbl, tbl
        );
    end loop;
end $$;

-- ── Organizations table RLS ──────────────────────────────────────────────────
create policy "org_select" on organizations for select using (
    auth.is_super_admin() or
    id = any(select auth.user_tenant_ids())
);

create policy "org_insert" on organizations for insert with check (
    auth.is_super_admin()
);

create policy "org_update" on organizations for update using (
    auth.is_super_admin() or
    id = any(select auth.user_tenant_ids())
);

create policy "org_delete" on organizations for delete using (
    auth.is_super_admin()
);

-- ── Organization Members RLS (self) ─────────────────────────────────────────
-- Members can see their own memberships.
-- Super admin sees all.
-- Other members see members within their organization.
create policy "org_members_select" on organization_members for select using (
    auth.is_super_admin() or
    user_id = auth.uid() or
    organization_id = any(select auth.user_tenant_ids())
);

create policy "org_members_insert" on organization_members for insert with check (
    auth.is_super_admin() or
    organization_id = any(select auth.user_tenant_ids())
);

create policy "org_members_update" on organization_members for update using (
    auth.is_super_admin() or
    organization_id = any(select auth.user_tenant_ids())
);

create policy "org_members_delete" on organization_members for delete using (
    auth.is_super_admin() or
    organization_id = any(select auth.user_tenant_ids())
);

-- ── Roles RLS ───────────────────────────────────────────────────────────────
create policy "roles_select" on roles for select using (
    auth.is_super_admin() or
    organization_id is null or
    organization_id = any(select auth.user_tenant_ids())
);

create policy "roles_insert" on roles for insert with check (
    auth.is_super_admin()
);

create policy "roles_update" on roles for update using (
    auth.is_super_admin()
);

create policy "roles_delete" on roles for delete using (
    auth.is_super_admin()
);

-- ── Permission RLS ──────────────────────────────────────────────────────────
create policy "perms_select" on permissions for select to authenticated using (true);
create policy "perms_insert" on permissions for insert with check (auth.is_super_admin());
create policy "perms_update" on permissions for update using (auth.is_super_admin());
create policy "perms_delete" on permissions for delete using (auth.is_super_admin());

-- ── Super Admins RLS ─────────────────────────────────────────────────────────
create policy "super_admins_select" on super_admins for select using (auth.is_super_admin());
create policy "super_admins_insert" on super_admins for insert with check (auth.is_super_admin());
create policy "super_admins_update" on super_admins for update using (auth.is_super_admin());
create policy "super_admins_delete" on super_admins for delete using (auth.is_super_admin());

-- ── Service role always has full access (for backend) ────────────────────────
do $$
declare
    tbl text;
begin
    for tbl in
        select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
    loop
        execute format(
            'create policy "service_role_all_%I" on %I for all to service_role using (true) with check (true);',
            tbl, tbl
        );
    end loop;
end $$;

-- ============================================================================
-- Seed: Default Permissions
-- ============================================================================
insert into permissions (key, label, description, category) values
    ('manage_workspace',    'Manage Workspace',     'View and edit workspace settings', 'workspace'),
    ('manage_users',        'Manage Users',         'Invite and remove team members', 'workspace'),
    ('manage_roles',        'Manage Roles',         'Create and assign roles', 'workspace'),
    ('manage_whatsapp',     'Manage WhatsApp',      'Connect and manage WhatsApp numbers', 'whatsapp'),
    ('manage_groups',       'Manage Groups',        'Manage WhatsApp group tracking', 'whatsapp'),
    ('view_inbox',          'View Inbox',           'Read conversations in the inbox', 'inbox'),
    ('reply_whatsapp',      'Reply via WhatsApp',   'Send replies from the inbox', 'inbox'),
    ('view_market',         'View Market',          'Access market intelligence', 'market'),
    ('manage_market',       'Manage Market',        'Edit market data and listings', 'market'),
    ('manage_ai',           'Manage AI',            'Configure AI settings and prompts', 'ai'),
    ('view_reports',        'View Reports',         'Access analytics and reports', 'analytics'),
    ('manage_billing',      'Manage Billing',       'Access billing and subscription', 'billing'),
    ('delete_workspace',    'Delete Workspace',     'Delete the workspace and all data', 'workspace'),
    ('export_data',         'Export Data',          'Export workspace data', 'data'),
    ('manage_integrations', 'Manage Integrations',  'Configure third-party integrations', 'integrations')
on conflict (key) do nothing;

-- ============================================================================
-- Seed: System Roles (permission keys mapped by slug)
-- ============================================================================
-- We create system roles without an organization_id (globally available templates).
-- Actual org members will be assigned org-specific copies or references.

-- Note: These are inserted as templates. Actual role-permission mapping
-- requires the roles to exist first. We use a function-based approach.

create or replace function seed_system_roles()
returns void
language plpgsql
as $$
declare
    v_owner_id bigint;
    v_admin_id bigint;
    v_broker_id bigint;
    v_analyst_id bigint;
    v_viewer_id bigint;
begin
    -- Insert roles (idempotent)
    insert into roles (organization_id, name, slug, description, is_system)
    values
        (null, 'Owner',    'owner',    'Full access to everything in the workspace', true),
        (null, 'Admin',    'admin',    'Administrative access to most features', true),
        (null, 'Broker',   'broker',   'Day-to-day broker operations', true),
        (null, 'Analyst',  'analyst',  'Market analysis and reporting', true),
        (null, 'Viewer',   'viewer',   'Read-only access to the workspace', true)
    on conflict (organization_id, slug) do nothing;

    -- Get role IDs
    select id into v_owner_id from roles where slug = 'owner' and organization_id is null;
    select id into v_admin_id from roles where slug = 'admin' and organization_id is null;
    select id into v_broker_id from roles where slug = 'broker' and organization_id is null;
    select id into v_analyst_id from roles where slug = 'analyst' and organization_id is null;
    select id into v_viewer_id from roles where slug = 'viewer' and organization_id is null;

    -- Owner: all permissions
    insert into role_permissions (role_id, permission_id)
    select v_owner_id, id from permissions
    on conflict do nothing;

    -- Admin: almost everything except delete_workspace, manage_billing
    insert into role_permissions (role_id, permission_id)
    select v_admin_id, id from permissions
    where key not in ('delete_workspace', 'manage_billing')
    on conflict do nothing;

    -- Broker: inbox, market, whatsapp
    insert into role_permissions (role_id, permission_id)
    select v_broker_id, id from permissions
    where key in ('view_inbox', 'reply_whatsapp', 'view_market', 'manage_whatsapp', 'manage_groups')
    on conflict do nothing;

    -- Analyst: view only + reports
    insert into role_permissions (role_id, permission_id)
    select v_analyst_id, id from permissions
    where key in ('view_inbox', 'view_market', 'view_reports', 'export_data')
    on conflict do nothing;

    -- Viewer: read-only
    insert into role_permissions (role_id, permission_id)
    select v_viewer_id, id from permissions
    where key in ('view_inbox', 'view_market')
    on conflict do nothing;
end;
$$;

select seed_system_roles();

-- ============================================================================
-- Trigger: set updated_at for organizations
-- ============================================================================
create trigger set_organizations_updated_at
    before update on organizations
    for each row
    execute function trigger_set_updated_at();

-- ============================================================================
-- Trigger: auto-assign tenant_id on raw_message insert based on WhatsApp connection
-- ============================================================================
create or replace function auto_assign_tenant_raw_message()
returns trigger
language plpgsql
as $$
declare
    v_org_id uuid;
begin
    -- Try to determine tenant from the WhatsApp connection
    -- The raw_payload contains instance info; fallback to sender_phone
    select organization_id into v_org_id
    from org_whatsapp_connections
    where phone_number = NEW.sender_phone
       or instance_name = NEW.raw_payload->>'instance'
    limit 1;

    if v_org_id is not null then
        NEW.tenant_id = v_org_id;
    end if;

    return NEW;
end;
$$;

create trigger trg_raw_messages_tenant
    before insert on raw_messages
    for each row
    execute function auto_assign_tenant_raw_message();

-- ============================================================================
-- Trigger: propagate tenant_id from raw_message to parsed_output
-- ============================================================================
create or replace function propagate_tenant_parsed_output()
returns trigger
language plpgsql
as $$
begin
    select tenant_id into NEW.tenant_id
    from raw_messages where id = NEW.raw_message_id;
    return NEW;
end;
$$;

create trigger trg_parsed_output_tenant
    before insert on parsed_output
    for each row
    execute function propagate_tenant_parsed_output();

-- ============================================================================
-- Trigger: propagate tenant_id from raw_message to observations
-- ============================================================================
create or replace function propagate_tenant_observations()
returns trigger
language plpgsql
as $$
begin
    select tenant_id into NEW.tenant_id
    from raw_messages where id = NEW.raw_message_id;
    return NEW;
end;
$$;

create trigger trg_observations_tenant
    before insert on observations
    for each row
    execute function propagate_tenant_observations();

create trigger trg_observation_evidence_tenant
    before insert on observation_evidence
    for each row
    execute function propagate_tenant_observations();
