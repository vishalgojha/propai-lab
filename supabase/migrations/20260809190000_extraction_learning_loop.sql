-- Tenant-scoped, human-approved extraction examples.
-- These examples improve future prompts; they never modify the source message
-- and never become global training data without an explicit promotion step.
create table if not exists public.extraction_learning_examples (
    id bigint generated always as identity primary key,
    tenant_id uuid not null references public.organizations(id) on delete cascade,
    raw_message_id bigint references public.raw_messages(id) on delete set null,
    source_schema text,
    source_text text not null,
    field_name text not null,
    original_value jsonb,
    corrected_value jsonb,
    status text not null default 'approved'
        check (status in ('pending', 'approved', 'rejected')),
    created_at timestamptz not null default now(),
    approved_at timestamptz,
    approved_by uuid,
    unique (tenant_id, raw_message_id, source_schema, field_name, corrected_value)
);

create index if not exists idx_extraction_learning_examples_lookup
    on public.extraction_learning_examples (tenant_id, status, created_at desc);

alter table public.extraction_learning_examples enable row level security;
revoke all on table public.extraction_learning_examples from anon, authenticated;
grant all on table public.extraction_learning_examples to service_role;
grant usage, select on sequence public.extraction_learning_examples_id_seq to service_role;
