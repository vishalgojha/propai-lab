-- Restrict operational backfill helpers to the service role.

revoke all on function public.infer_micro_market_from_text(text) from public, anon, authenticated;
grant execute on function public.infer_micro_market_from_text(text) to service_role;

revoke all on function public.backfill_parsed_micro_markets_batch(bigint, integer) from public, anon, authenticated;
grant execute on function public.backfill_parsed_micro_markets_batch(bigint, integer) to service_role;
