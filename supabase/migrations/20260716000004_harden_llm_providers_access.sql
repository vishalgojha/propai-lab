-- ============================================================================
-- Lock down llm_providers table access
-- ============================================================================
-- RLS policies were removed in the earlier hardening migration, but table-level
-- grants also need to be explicit in Supabase. Keep the table available to the
-- backend service role only.
-- ============================================================================

revoke all on table public.llm_providers from public, anon, authenticated;
grant select, insert, update, delete on table public.llm_providers to service_role;
