-- ============================================================================
-- PropAI RLS Policies
-- ============================================================================

-- Enable RLS on all tables
do $$
declare
    tbl text;
begin
    for tbl in
        select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
    loop
        execute format('alter table %I enable row level security;', tbl);
    end loop;
end $$;

-- ── Helper: every authenticated user can read all rows ────────────
-- This is Phase 1 RLS — ownership-based policies come after auth is wired.

do $$
declare
    tbl text;
begin
    for tbl in
        select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
    loop
        execute format(
            'create policy "authenticated_select_%I" on %I for select to authenticated using (true);',
            tbl, tbl
        );
        execute format(
            'create policy "service_role_all_%I" on %I for all to service_role using (true) with check (true);',
            tbl, tbl
        );
    end loop;
end $$;

-- ── Insert/Update/Delete for authenticated users (broad for now) ──
-- Tighten these when user/team ownership is implemented.

do $$
declare
    tbl text;
begin
    for tbl in
        select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
    loop
        execute format(
            'create policy "authenticated_insert_%I" on %I for insert to authenticated with check (true);',
            tbl, tbl
        );
        execute format(
            'create policy "authenticated_update_%I" on %I for update to authenticated using (true) with check (true);',
            tbl, tbl
        );
        execute format(
            'create policy "authenticated_delete_%I" on %I for delete to authenticated using (true);',
            tbl, tbl
        );
    end loop;
end $$;