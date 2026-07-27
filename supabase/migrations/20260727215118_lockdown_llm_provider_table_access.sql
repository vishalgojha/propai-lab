-- Keep llm provider credentials backend-only while preserving the newer
-- tenant policies for future least-privilege redesign.
revoke all on table public.llm_providers
  from public, anon, authenticated;

grant select, insert, update, delete
  on table public.llm_providers
  to service_role;
