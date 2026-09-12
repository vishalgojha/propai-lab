-- Production drift left parsed_output_unified on the original narrow typed
-- projection. Application readers use the current listings_unified shape,
-- including normalized_message and listing_index. Recreate only this
-- compatibility view; no source rows are changed.
drop view if exists public.parsed_output_unified;

create view public.parsed_output_unified
with (security_invoker = true)
as
select * from public.listings_unified;

revoke all on public.parsed_output_unified from anon, authenticated;
grant select on public.parsed_output_unified to service_role;

notify pgrst, 'reload schema';
