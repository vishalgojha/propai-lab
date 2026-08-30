-- The worker-only queue claim function must never be callable by public roles.
revoke all on function public.claim_extraction_reprocessing_jobs(integer)
  from public, anon, authenticated;
grant execute on function public.claim_extraction_reprocessing_jobs(integer)
  to service_role;
