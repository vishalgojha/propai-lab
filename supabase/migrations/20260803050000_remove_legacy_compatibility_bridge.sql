-- The application now writes directly to the eight typed extraction tables.
-- Keep the *_legacy relations as historical archives, but remove the
-- deprecated relation names and their INSERT bridge so new code cannot
-- accidentally depend on the old flat schema again.

begin;

drop trigger if exists parsed_output_insert_compat on public.parsed_output;
drop trigger if exists listings_insert_compat on public.listings;
drop trigger if exists market_requirements_insert_compat on public.market_requirements;

drop view if exists public.parsed_output;
drop view if exists public.listings;
drop view if exists public.market_requirements;

drop function if exists public._compat_insert_parsed_output();
drop function if exists public._compat_forward_insert();

commit;
