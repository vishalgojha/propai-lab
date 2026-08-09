-- Harden functions reported by the Supabase database security linter.
--
-- These functions are used by server-side storage code or table triggers. They
-- are not public RPCs. Keep service_role access for controlled server calls,
-- while removing the default PUBLIC/anon/authenticated EXECUTE grant.

-- Pin lookup resolution for functions that do not need caller-controlled paths.
alter function public.trigger_market_requirements_updated_at()
  set search_path = public, pg_temp;
alter function public.enforce_org_phone_directory_cap()
  set search_path = public, pg_temp;
alter function public._typed_num(text)
  set search_path = public, pg_temp;
alter function public._typed_money(numeric, text)
  set search_path = public, pg_temp;
alter function public._typed_asset(text, text, text)
  set search_path = public, pg_temp;
alter function public._typed_tx(text, text, text)
  set search_path = public, pg_temp;
alter function public.normalize_building_name_for_quality(text)
  set search_path = public, pg_temp;
alter procedure public.purge_old_raw_messages()
  set search_path = public, pg_temp;
alter procedure public.purge_old_raw_batch()
  set search_path = public, pg_temp;
alter function public.normalize_whatsapp_phone_key(text)
  set search_path = public, pg_temp;

-- Also pin the SECURITY DEFINER functions, including trigger functions.
alter function public.backfill_listing_locality_from_building_name(regclass)
  set search_path = public, pg_temp;
alter function public.conversation_state_load(text)
  set search_path = public, pg_temp;
alter function public.conversation_state_upsert(text, jsonb)
  set search_path = public, pg_temp;
alter function public.enrich_group_member_display_name()
  set search_path = public, pg_temp;
alter function public.handle_new_user_personal_org()
  set search_path = public, auth, pg_temp;
alter function public.increment_extraction_cache_hit(bigint)
  set search_path = public, pg_temp;
alter function public.provision_workspace_ai_settings()
  set search_path = public, pg_temp;
alter function public.recompute_building_observed_listings()
  set search_path = public, pg_temp;
alter function public.refresh_building_observed_listings()
  set search_path = public, pg_temp;

-- Remove the default PUBLIC grant explicitly, then grant only the server role.
revoke execute on function public.backfill_listing_locality_from_building_name(regclass)
  from public, anon, authenticated;
revoke execute on function public.conversation_state_load(text)
  from public, anon, authenticated;
revoke execute on function public.conversation_state_upsert(text, jsonb)
  from public, anon, authenticated;
revoke execute on function public.enrich_group_member_display_name()
  from public, anon, authenticated;
revoke execute on function public.handle_new_user_personal_org()
  from public, anon, authenticated;
revoke execute on function public.increment_extraction_cache_hit(bigint)
  from public, anon, authenticated;
revoke execute on function public.provision_workspace_ai_settings()
  from public, anon, authenticated;
revoke execute on function public.recompute_building_observed_listings()
  from public, anon, authenticated;
revoke execute on function public.refresh_building_observed_listings()
  from public, anon, authenticated;

grant execute on function public.backfill_listing_locality_from_building_name(regclass)
  to service_role;
grant execute on function public.conversation_state_load(text)
  to service_role;
grant execute on function public.conversation_state_upsert(text, jsonb)
  to service_role;
grant execute on function public.enrich_group_member_display_name()
  to service_role;
grant execute on function public.handle_new_user_personal_org()
  to service_role;
grant execute on function public.increment_extraction_cache_hit(bigint)
  to service_role;
grant execute on function public.provision_workspace_ai_settings()
  to service_role;
grant execute on function public.recompute_building_observed_listings()
  to service_role;
grant execute on function public.refresh_building_observed_listings()
  to service_role;

-- These maintenance routines are procedures, not functions, and must not be
-- callable through the public API either.
revoke execute on procedure public.purge_old_raw_messages()
  from public, anon, authenticated;
revoke execute on procedure public.purge_old_raw_batch()
  from public, anon, authenticated;
grant execute on procedure public.purge_old_raw_messages()
  to service_role;
grant execute on procedure public.purge_old_raw_batch()
  to service_role;

-- Trigger entry points are invoked by PostgreSQL, not through /rpc.
revoke execute on function public.trigger_market_requirements_updated_at()
  from public, anon, authenticated;
revoke execute on function public.enforce_org_phone_directory_cap()
  from public, anon, authenticated;
grant execute on function public.trigger_market_requirements_updated_at()
  to service_role;
grant execute on function public.enforce_org_phone_directory_cap()
  to service_role;
