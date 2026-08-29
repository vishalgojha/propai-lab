-- These routines are called by server-side storage/worker code. They must
-- not be exposed as anonymous or authenticated PostgREST RPCs.

revoke all on function public.claim_extraction_repair_jobs(integer)
  from public, anon, authenticated;
grant execute on function public.claim_extraction_repair_jobs(integer)
  to service_role;

revoke all on function public.get_workspace_extraction_progress(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.get_workspace_extraction_progress(uuid, integer)
  to service_role;

revoke all on function public.rebuild_broker_team_intelligence()
  from public, anon, authenticated;
grant execute on function public.rebuild_broker_team_intelligence()
  to service_role;
