-- These are internal projections over tenant-protected typed tables. Public
-- clients must use the server routes, which apply the intended tenant/public
-- field contract; direct view access would expose the underlying projection.

alter view public.parsed_output_unified set (security_invoker = true);
alter view public.extraction_needs_review set (security_invoker = true);

revoke all on public.parsed_output_unified from public, anon, authenticated;
revoke all on public.extraction_needs_review from public, anon, authenticated;
grant select on public.parsed_output_unified to service_role;
grant select on public.extraction_needs_review to service_role;
