create table if not exists public.mcp_data_quality_events (
    id bigint generated always as identity primary key,
    severity text not null check (severity in ('HIGH', 'MEDIUM', 'LOW')),
    signature text not null,
    query text,
    listing_id text,
    failed_fields text[] not null default '{}',
    likely_cause text,
    occurred_at timestamptz not null default now()
);

create index if not exists idx_mcp_data_quality_events_signature_time
    on public.mcp_data_quality_events (signature, occurred_at desc);

alter table public.mcp_data_quality_events enable row level security;
revoke all on table public.mcp_data_quality_events from anon, authenticated;
grant all on table public.mcp_data_quality_events to service_role;
grant usage, select on sequence public.mcp_data_quality_events_id_seq to service_role;
