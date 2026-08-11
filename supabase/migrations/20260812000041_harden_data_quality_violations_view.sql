-- data_quality_violations is an internal operational audit view. Views use
-- their owner's privileges unless security_invoker is enabled, so the
-- postgres-owned view could otherwise bypass the caller's RLS policies.

begin;

alter view public.data_quality_violations
  set (security_invoker = true);

revoke all on public.data_quality_violations from public, anon, authenticated;
grant select on public.data_quality_violations to service_role;

commit;

notify pgrst, 'reload schema';
