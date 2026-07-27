-- This SECURITY DEFINER function is invoked by a database trigger, not by
-- client roles. Prevent direct invocation by API roles.
revoke all on function public.trg_update_broker_stats()
  from public, anon, authenticated;

grant execute on function public.trg_update_broker_stats()
  to service_role;
