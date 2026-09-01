-- Phase 2 security hardening: building identity maintenance is an internal
-- worker operation and must not be callable through public PostgREST RPCs.

alter function public.reconcile_enriched_building_identity(bigint)
  set search_path = pg_catalog, public;
revoke all on function public.reconcile_enriched_building_identity(bigint)
  from public, anon, authenticated;
grant execute on function public.reconcile_enriched_building_identity(bigint)
  to service_role;

alter function public.refresh_building_identity_review_queue()
  set search_path = pg_catalog, public;
revoke all on function public.refresh_building_identity_review_queue()
  from public, anon, authenticated;
grant execute on function public.refresh_building_identity_review_queue()
  to service_role;

alter function public.requeue_building_enrichment_for_context()
  set search_path = pg_catalog, public;
revoke all on function public.requeue_building_enrichment_for_context()
  from public, anon, authenticated;
grant execute on function public.requeue_building_enrichment_for_context()
  to service_role;
