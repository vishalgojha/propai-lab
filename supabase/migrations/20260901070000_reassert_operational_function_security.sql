-- Phase 1 security hardening: make the previously reviewed operational
-- functions safe even if an earlier grant or function replacement regressed.
-- This migration is intentionally idempotent and does not change application
-- data. It must be applied through the normal Supabase migration process.

alter function public.claim_extraction_reprocessing_jobs(integer)
  set search_path = pg_catalog, public;
revoke all on function public.claim_extraction_reprocessing_jobs(integer)
  from public, anon, authenticated;
grant execute on function public.claim_extraction_reprocessing_jobs(integer)
  to service_role;

alter function public.get_building_enrichment_worker_evidence()
  set search_path = pg_catalog, public;
revoke all on function public.get_building_enrichment_worker_evidence()
  from public, anon, authenticated;
grant execute on function public.get_building_enrichment_worker_evidence()
  to service_role;

alter function public.touch_social_flow_meta_settings_updated_at()
  set search_path = pg_catalog, public;
revoke all on function public.touch_social_flow_meta_settings_updated_at()
  from public, anon, authenticated;
grant execute on function public.touch_social_flow_meta_settings_updated_at()
  to service_role;
