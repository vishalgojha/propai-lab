-- ============================================================================
-- Follow-up Supabase security hardening
-- ============================================================================
-- Close the remaining exposed functions from the audit:
--   - rls_auto_enable()
--   - _t_fixed()
-- Both are only touched if they exist on the target database.
-- ============================================================================

do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'alter function public.rls_auto_enable() set search_path = public, pg_temp';
    execute 'revoke all on function public.rls_auto_enable() from public, anon, authenticated';
    execute 'grant execute on function public.rls_auto_enable() to service_role';
  end if;

  if to_regprocedure('public._t_fixed()') is not null then
    execute 'alter function public._t_fixed() set search_path = public, pg_temp';
  end if;
end
$$;
