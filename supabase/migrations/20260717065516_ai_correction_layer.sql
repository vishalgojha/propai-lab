alter table public.parsed_output
    add column if not exists correction_hash text,
    add column if not exists corrected_fields text[] not null default '{}',
    add column if not exists correction_confidence numeric,
    add column if not exists corrected_at timestamptz;

alter table public.parsed_output
    drop constraint if exists parsed_output_correction_confidence_check;

alter table public.parsed_output
    add constraint parsed_output_correction_confidence_check
    check (
        correction_confidence is null
        or correction_confidence between 0 and 1
    );

create index if not exists idx_parsed_output_uncorrected_confidence
    on public.parsed_output (confidence, created_at)
    where corrected_at is null;

create index if not exists idx_parsed_output_correction_hash
    on public.parsed_output (correction_hash)
    where corrected_at is not null;

create table if not exists public.ai_correction_runs (
    id bigint generated always as identity primary key,
    run_slot timestamptz unique,
    trigger text not null default 'scheduled',
    status text not null default 'running'
        check (status in ('running', 'complete', 'failed', 'skipped')),
    dry_run boolean not null default false,
    selected_count integer not null default 0,
    processed_count integer not null default 0,
    corrected_count integer not null default 0,
    reused_count integer not null default 0,
    skipped_count integer not null default 0,
    api_calls integer not null default 0,
    input_tokens bigint not null default 0,
    output_tokens bigint not null default 0,
    estimated_cost_usd numeric not null default 0,
    error text,
    started_at timestamptz not null default now(),
    finished_at timestamptz
);

alter table public.ai_correction_runs enable row level security;
revoke all on table public.ai_correction_runs from anon, authenticated;
grant all on table public.ai_correction_runs to service_role;
grant usage, select on sequence public.ai_correction_runs_id_seq to service_role;
