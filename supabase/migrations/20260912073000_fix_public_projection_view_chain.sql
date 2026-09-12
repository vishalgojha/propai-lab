-- The buyer-facing projection is owner-secured, but its legacy dependency
-- chain was still invoker-secured. That made anonymous reads inherit the
-- service-role-only policies of the typed tables and return zero rows.
alter view public.listings_unified_typed_projection
  set (security_invoker = false);
alter view public.listings_unified
  set (security_invoker = false);
alter view public.listings_unified_public_legacy
  set (security_invoker = false);

-- These are internal compatibility/projection relations. Do not expose them
-- directly; callers use the explicitly privacy-shaped public projection.
revoke all on public.listings_unified_typed_projection from anon, authenticated;
revoke all on public.listings_unified from anon, authenticated;
revoke all on public.listings_unified_public_legacy from anon, authenticated;

grant select on public.listings_unified_public to anon, authenticated;
grant select on public.listings_by_building_public to anon, authenticated;
notify pgrst, 'reload schema';
