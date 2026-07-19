-- ============================================================================
-- Tenant isolation hardening (Tier 2): close the gaps the audit found.
-- Tables that had NO tenant scoping at all (isolation relied solely on
-- per-call params, or was absent): ai_chat_sessions, ai_chat_messages,
-- user_profiles, saved_inbox_views, llm_providers.
-- saved_inbox_views is in the RLS loop of 20260709000000 but was
-- missing its tenant_id column; the other four were missing entirely.
-- Pattern mirrors 20260709000000_multi_tenant_rbac.sql exactly:
-- uses auth.user_tenant_ids() + auth.is_super_admin() (NOT a new helper).
-- ============================================================================

do $$
declare
  default_tenant uuid := '00000000-0000-0000-0000-000000000010';
begin
  -- ai_chat_sessions: base table may not exist yet (earlier migration may not
  -- have been applied to this project). Create with tenant_id if missing.
  create table if not exists public.ai_chat_sessions (
    id uuid primary key default gen_random_uuid(),
    broker_phone text not null,
    title text not null default 'New chat',
    tenant_id uuid references organizations(id),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  );
  alter table ai_chat_sessions
    add column if not exists tenant_id uuid references organizations(id);
  update ai_chat_sessions set tenant_id = default_tenant where tenant_id is null;
  alter table ai_chat_sessions alter column tenant_id set not null;
  create index if not exists idx_ai_chat_sessions_tenant
    on ai_chat_sessions(tenant_id);

  -- ai_chat_messages
  create table if not exists public.ai_chat_messages (
    id uuid primary key default gen_random_uuid(),
    session_id uuid not null references public.ai_chat_sessions(id) on delete cascade,
    role text not null check (role in ('user', 'assistant', 'system')),
    content text not null,
    tenant_id uuid references organizations(id),
    created_at timestamptz not null default now()
  );
  alter table ai_chat_messages
    add column if not exists tenant_id uuid references organizations(id);
  update ai_chat_messages set tenant_id = default_tenant where tenant_id is null;
  alter table ai_chat_messages alter column tenant_id set not null;
  create index if not exists idx_ai_chat_messages_tenant
    on ai_chat_messages(tenant_id);

  -- user_profiles
  alter table user_profiles
    add column if not exists tenant_id uuid references organizations(id);
  update user_profiles set tenant_id = default_tenant where tenant_id is null;
  alter table user_profiles alter column tenant_id set not null;
  create index if not exists idx_user_profiles_tenant
    on user_profiles(tenant_id);

  -- saved_inbox_views (column may already exist from prior migration)
  alter table saved_inbox_views
    add column if not exists tenant_id uuid references organizations(id);
  update saved_inbox_views set tenant_id = default_tenant where tenant_id is null;
  alter table saved_inbox_views alter column tenant_id set not null;
  create index if not exists idx_saved_inbox_views_tenant
    on saved_inbox_views(tenant_id);

  -- llm_providers (per-tenant: not shared infra)
  alter table llm_providers
    add column if not exists tenant_id uuid references organizations(id);
  update llm_providers set tenant_id = default_tenant where tenant_id is null;
  alter table llm_providers alter column tenant_id set not null;
  create index if not exists idx_llm_providers_tenant
    on llm_providers(tenant_id);
end $$;

-- ----------------------------------------------------------------------------
-- RLS: append the four newly-columned tables to the same tenant-isolation
-- loop used by 20260709000000. Super-admins bypass; regular users
-- are scoped to their orgs via auth.user_tenant_ids().
-- ----------------------------------------------------------------------------
do $$
declare
  tbl text;
  new_tables text[] := array[
    'ai_chat_sessions', 'ai_chat_messages',
    'user_profiles', 'llm_providers'
  ];
begin
  foreach tbl in array new_tables
  loop
    execute format(
      'alter table %I enable row level security;', tbl
    );
    execute format(
      'drop policy if exists "tenant_select_%I" on %I;', tbl, tbl
    );
    execute format(
      'create policy "tenant_select_%I" on %I for select using (
        auth.is_super_admin() or
        tenant_id = any(select auth.user_tenant_ids())
      );', tbl, tbl
    );
    execute format(
      'drop policy if exists "tenant_insert_%I" on %I;', tbl, tbl
    );
    execute format(
      'create policy "tenant_insert_%I" on %I for insert with check (
        auth.is_super_admin() or
        tenant_id = any(select auth.user_tenant_ids())
      );', tbl, tbl
    );
    execute format(
      'drop policy if exists "tenant_update_%I" on %I;', tbl, tbl
    );
    execute format(
      'create policy "tenant_update_%I" on %I for update using (
        auth.is_super_admin() or
        tenant_id = any(select auth.user_tenant_ids())
      ) with check (
        auth.is_super_admin() or
        tenant_id = any(select auth.user_tenant_ids())
      );', tbl, tbl
    );
    execute format(
      'drop policy if exists "tenant_delete_%I" on %I;', tbl, tbl
    );
    execute format(
      'create policy "tenant_delete_%I" on %I for delete using (
        auth.is_super_admin() or
        tenant_id = any(select auth.user_tenant_ids())
      );', tbl, tbl
    );
  end loop;
end $$;

-- saved_inbox_views already had RLS policies but no tenant_id column;
-- now that the column exists, re-affirm its policies point at it.
alter table saved_inbox_views enable row level security;
drop policy if exists "tenant_select_saved_inbox_views" on saved_inbox_views;
create policy "tenant_select_saved_inbox_views" on saved_inbox_views for select using (
  auth.is_super_admin() or
  tenant_id = any(select auth.user_tenant_ids())
);
drop policy if exists "tenant_insert_saved_inbox_views" on saved_inbox_views;
create policy "tenant_insert_saved_inbox_views" on saved_inbox_views for insert with check (
  auth.is_super_admin() or
  tenant_id = any(select auth.user_tenant_ids())
);
drop policy if exists "tenant_update_saved_inbox_views" on saved_inbox_views;
create policy "tenant_update_saved_inbox_views" on saved_inbox_views for update using (
  auth.is_super_admin() or
  tenant_id = any(select auth.user_tenant_ids())
) with check (
  auth.is_super_admin() or
  tenant_id = any(select auth.user_tenant_ids())
);
drop policy if exists "tenant_delete_saved_inbox_views" on saved_inbox_views;
create policy "tenant_delete_saved_inbox_views" on saved_inbox_views for delete using (
  auth.is_super_admin() or
  tenant_id = any(select auth.user_tenant_ids())
);
