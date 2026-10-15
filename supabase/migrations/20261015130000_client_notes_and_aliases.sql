-- Client memory: durable notes and name/phone aliases so a client can be
-- resolved from free-text WhatsApp self-chat ("note for Ravi that ...").
create table if not exists public.client_aliases (
    id              bigint generated always as identity primary key,
    client_id       bigint not null references public.clients(id) on delete cascade,
    tenant_id       uuid references public.organizations(id) on delete cascade,
    alias           text not null,
    normalized_alias text not null,
    source          text default 'manual',
    confidence      numeric default 1.0,
    created_at      timestamptz not null default now()
);

create unique index if not exists client_aliases_tenant_norm_key
    on public.client_aliases (tenant_id, normalized_alias);
create index if not exists idx_client_aliases_client
    on public.client_aliases (client_id, confidence desc);

create table if not exists public.client_notes (
    id                  bigint generated always as identity primary key,
    client_id           bigint not null references public.clients(id) on delete cascade,
    tenant_id           uuid references public.organizations(id) on delete cascade,
    note_type           text default 'note',
    body                text not null,
    source_text         text default '',
    source_jid          text default '',
    source_message_id   text default '',
    confidence          numeric default 1.0,
    is_active           smallint default 1,
    supersedes_note_id  bigint references public.client_notes(id) on delete set null,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists idx_client_notes_client
    on public.client_notes (client_id, is_active, created_at desc);

drop trigger if exists set_client_notes_updated_at on public.client_notes;
create trigger set_client_notes_updated_at
    before update on public.client_notes
    for each row
    execute function trigger_set_updated_at();

alter table public.client_aliases enable row level security;
alter table public.client_notes enable row level security;

drop policy if exists client_aliases_all on public.client_aliases;
create policy client_aliases_all
    on public.client_aliases for all using (
        app_private.is_super_admin() or tenant_id = any(select app_private.user_tenant_ids())
    ) with check (
        app_private.is_super_admin() or tenant_id = any(select app_private.user_tenant_ids())
    );

drop policy if exists client_notes_all on public.client_notes;
create policy client_notes_all
    on public.client_notes for all using (
        app_private.is_super_admin() or tenant_id = any(select app_private.user_tenant_ids())
    ) with check (
        app_private.is_super_admin() or tenant_id = any(select app_private.user_tenant_ids())
    );
