create table if not exists public.group_members (
    id bigint generated always as identity primary key,
    tenant_id uuid not null,
    group_id text not null,
    member_jid text not null,
    member_phone text,
    display_name text,
    is_admin boolean default false,
    first_seen_at timestamptz not null default now(),
    last_seen_at timestamptz not null default now(),
    unique (tenant_id, group_id, member_jid)
);

create index if not exists idx_group_members_group
    on public.group_members (tenant_id, group_id);

create index if not exists idx_group_members_phone
    on public.group_members (tenant_id, member_phone);
