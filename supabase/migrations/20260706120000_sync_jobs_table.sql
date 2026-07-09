create table if not exists sync_jobs (
    id               bigint generated always as identity primary key,
    source           text not null,
    instance         text not null default '',
    group_id         text not null,
    group_name       text default '',
    meta             jsonb default '{}',
    status           text default 'pending',
    records_found    integer default 0,
    records_processed integer default 0,
    records_failed   integer default 0,
    last_cursor      text,
    error            text,
    participants     integer default 0,
    started_at       timestamptz,
    finished_at      timestamptz,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

create index if not exists idx_sync_jobs_source on sync_jobs (source);
create index if not exists idx_sync_jobs_group_id on sync_jobs (group_id);
create index if not exists idx_sync_jobs_status on sync_jobs (status);
