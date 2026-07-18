-- This project has explicit default EXECUTE grants for Data API roles, so
-- revoking from PUBLIC alone is insufficient.  Market Inbox RPCs are backend
-- internals and must only be callable with the server-side service role.

revoke all on function public.market_normalize_phone(text)
    from public, anon, authenticated;
revoke all on function public.market_clean_person_name(text)
    from public, anon, authenticated;
revoke all on function public.market_name_key(text)
    from public, anon, authenticated;
revoke all on function public.market_is_group(text)
    from public, anon, authenticated;
revoke all on function public.get_market_brokers_feed(integer, integer, integer, uuid)
    from public, anon, authenticated;
revoke all on function public.get_market_observations_feed(integer, integer, text, text, uuid)
    from public, anon, authenticated;

grant execute on function public.market_normalize_phone(text) to service_role;
grant execute on function public.market_clean_person_name(text) to service_role;
grant execute on function public.market_name_key(text) to service_role;
grant execute on function public.market_is_group(text) to service_role;
grant execute on function public.get_market_brokers_feed(integer, integer, integer, uuid) to service_role;
grant execute on function public.get_market_observations_feed(integer, integer, text, text, uuid) to service_role;
