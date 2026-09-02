-- Serialize concurrent exact-copy extraction misses. The claim is a short
-- lived coordination row; it never stores model output or merges evidence.
create table if not exists public.shared_extraction_claims (
  content_hash text primary key,
  first_raw_message_id bigint not null references public.raw_messages(id) on delete cascade,
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  claimed_at timestamptz not null default now()
);

alter table public.shared_extraction_claims enable row level security;
drop policy if exists shared_extraction_claims_service_role on public.shared_extraction_claims;
create policy shared_extraction_claims_service_role
  on public.shared_extraction_claims for all to service_role
  using (true) with check (true);

revoke all on table public.shared_extraction_claims from anon, authenticated;
grant all on table public.shared_extraction_claims to service_role;
