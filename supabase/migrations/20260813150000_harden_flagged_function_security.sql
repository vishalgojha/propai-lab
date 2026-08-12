-- Harden functions reported by the Supabase database security linter.
-- These functions are called by trusted server-side jobs/API code, not by the
-- public Data API roles.

alter function public.get_building_enrichment_worker_evidence()
  set search_path = public, pg_temp;
alter function public.backfill_listing_locality_from_extraction(regclass)
  set search_path = public, pg_temp;
alter function public.cleanup_whatsapp_webhook_outbox(interval)
  set search_path = public, pg_temp;
alter function public.get_extraction_progress(integer, uuid)
  set search_path = public, pg_temp;

revoke all on function public.get_building_enrichment_worker_evidence()
  from public, anon, authenticated;
revoke all on function public.backfill_listing_locality_from_extraction(regclass)
  from public, anon, authenticated;
revoke all on function public.cleanup_whatsapp_webhook_outbox(interval)
  from public, anon, authenticated;
revoke all on function public.get_extraction_progress(integer, uuid)
  from public, anon, authenticated;

grant execute on function public.get_building_enrichment_worker_evidence()
  to service_role;
grant execute on function public.backfill_listing_locality_from_extraction(regclass)
  to service_role;
grant execute on function public.cleanup_whatsapp_webhook_outbox(interval)
  to service_role;
grant execute on function public.get_extraction_progress(integer, uuid)
  to service_role;
