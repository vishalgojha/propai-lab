-- One extraction claim per tenant and exact broker-content fingerprint.
-- Raw events remain immutable evidence; this table only serializes the
-- extraction decision so concurrent workers cannot both become baselines.
create table if not exists public.raw_message_dedupe_claims (
    tenant_id uuid not null,
    author_content_fingerprint text not null,
    first_raw_message_id bigint not null references public.raw_messages(id) on delete cascade,
    created_at timestamptz not null default now(),
    primary key (tenant_id, author_content_fingerprint)
);

create index if not exists raw_message_dedupe_claims_first_raw_idx
    on public.raw_message_dedupe_claims (first_raw_message_id);

alter table public.raw_message_dedupe_claims enable row level security;

drop policy if exists raw_message_dedupe_claims_service_role on public.raw_message_dedupe_claims;
create policy raw_message_dedupe_claims_service_role
    on public.raw_message_dedupe_claims for all to service_role
    using (true) with check (true);
