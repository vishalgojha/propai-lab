-- Internal Notes
--
-- Deliberately NOT sent over WhatsApp — never touches raw_messages or the
-- whatsmeow ingestor. This is a first-party annotation layer for the PropAI
-- team, stored in the same Postgres but kept separate from ingested data.
--
-- entity_type/entity_id is intentionally generic (rather than a separate table
-- per surface) because chats, brokers, and buildings all need the exact same
-- author + mention + timestamp shape. Adding a new noteable surface in the
-- future requires zero schema changes — just use a new entity_type string.

create table if not exists internal_notes (
    id                  bigint generated always as identity primary key,
    entity_type         text not null check (entity_type in ('chat', 'broker', 'building')),
    entity_id           text not null,
    author_id           bigint not null references team_members(id) on delete cascade,
    mentioned_member_ids jsonb not null default '[]',
    body                text not null,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index if not exists idx_internal_notes_entity
    on internal_notes(entity_type, entity_id, created_at desc);
