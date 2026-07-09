-- ============================================================================
-- Core Tables for PropAI — Phase 1
-- raw_messages, parsed_output, listings, brokers, clients, buildings
-- ============================================================================

-- ── Extensions ─────────────────────────────────────────────────────────────
create extension if not exists "uuid-ossp";
create extension if not exists "vector";

-- ── raw_messages ───────────────────────────────────────────────────────────
create table if not exists raw_messages (
    id              bigint generated always as identity primary key,
    group_name      text not null default '',
    sender          text not null default '',
    message         text not null,
    message_type    text not null default 'text',
    timestamp       timestamptz not null default now(),
    source          text not null default 'WHATSAPP',
    raw_payload     jsonb default '{}',
    message_uid     text,
    pipeline_version text,
    synced_at       timestamptz,
    event_id        text,
    sender_jid      text default '',
    sender_phone    text default '',
    attachments     jsonb default '[]',
    reply_context   jsonb default '{}',
    created_at      timestamptz not null default now()
);

-- indexes
create index idx_raw_messages_timestamp on raw_messages(timestamp desc);
create index idx_raw_messages_group on raw_messages(group_name);
create index idx_raw_messages_sender on raw_messages(sender);
create index idx_raw_messages_message_uid on raw_messages(message_uid) where message_uid is not null;
create index idx_raw_messages_sender_phone on raw_messages(sender_phone);
create index idx_raw_messages_event_id on raw_messages(event_id);

-- full-text search (use Postgres built-in)
create index idx_raw_messages_fts
    on raw_messages
    using gin (to_tsvector('english', message));

-- ── parsed_output ──────────────────────────────────────────────────────────
create table if not exists parsed_output (
    id              bigint generated always as identity primary key,
    raw_message_id  bigint not null references raw_messages(id) on delete cascade,
    message_type    text,
    bhk             text,
    price           numeric,
    price_unit      text,
    area_sqft       numeric,
    furnishing      text,
    location_raw    text,
    building_name   text,
    landmark_name   text,
    street_name     text,
    area            text,
    micro_market    text,
    developer       text,
    broker_name     text,
    broker_phone    text,
    intent          text,
    principal       text,
    forwarded       boolean default false,
    profile_name    text,
    confidence      numeric default 0.0,
    raw_payload     jsonb default '{}',
    location        jsonb,
    listing_index   integer default 0,
    summary_title   text,
    reparsed_at     timestamptz,
    event_id        text,
    created_at      timestamptz not null default now()
);

-- indexes
create index idx_parsed_raw_message_id on parsed_output(raw_message_id);
create index idx_parsed_micro_market on parsed_output(micro_market);
create index idx_parsed_building_name on parsed_output(building_name);
create index idx_parsed_broker_phone on parsed_output(broker_phone);
create index idx_parsed_intent on parsed_output(intent);
create index idx_parsed_created_at on parsed_output(created_at desc);
create index idx_parsed_principal on parsed_output(principal);

-- ── listings ───────────────────────────────────────────────────────────────
create table if not exists listings (
    id              bigint generated always as identity primary key,
    fingerprint     text not null unique,
    intent          text,
    bhk             text,
    price           numeric,
    price_unit      text,
    price_per_sqft  numeric,
    area_sqft       numeric,
    furnishing      text,
    location_label  text,
    building_name   text,
    landmark_name   text,
    micro_market    text,
    street_name     text,
    developer       text,
    broker_name     text,
    broker_phone    text,
    floor_description text,
    view            text,
    orientation     text,
    pic_token       text,
    listing_source  text,
    first_seen      timestamptz not null default now(),
    last_seen       timestamptz not null default now(),
    observation_count integer not null default 0,
    group_count     integer not null default 0,
    latest_raw_message_id bigint references raw_messages(id),
    representative_raw_message_id bigint references raw_messages(id),
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

-- indexes
create index idx_listings_fingerprint on listings(fingerprint);
create index idx_listings_micro_market on listings(micro_market);
create index idx_listings_building_name on listings(building_name);
create index idx_listings_broker_phone on listings(broker_phone);
create index idx_listings_intent on listings(intent);
create index idx_listings_bhk on listings(bhk);
create index idx_listings_last_seen on listings(last_seen desc);
create index idx_listings_created_at on listings(created_at desc);

-- trigger for updated_at
create or replace function trigger_set_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

create trigger set_listings_updated_at
    before update on listings
    for each row
    execute function trigger_set_updated_at();

-- ── brokers ────────────────────────────────────────────────────────────────
create table if not exists brokers (
    id              bigint generated always as identity primary key,
    identity_key    text not null unique,
    canonical_name  text not null default '',
    primary_phone   text,
    first_seen_at   timestamptz,
    last_seen_at    timestamptz,
    observation_count integer not null default 0,
    listing_count   integer not null default 0,
    requirement_count integer not null default 0,
    rental_count    integer not null default 0,
    commercial_count integer not null default 0,
    group_count     integer not null default 0,
    market_count    integer not null default 0,
    building_count  integer default 0,
    active_days_30  integer default 0,
    avg_ticket      numeric,
    is_hidden       boolean default false,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index idx_brokers_identity_key on brokers(identity_key);
create index idx_brokers_primary_phone on brokers(primary_phone);
create index idx_brokers_canonical_name on brokers(canonical_name);
create index idx_brokers_observation_count on brokers(observation_count desc);
create index idx_brokers_is_hidden on brokers(is_hidden) where is_hidden = false;
create index idx_brokers_last_seen on brokers(last_seen_at desc);

create trigger set_brokers_updated_at
    before update on brokers
    for each row
    execute function trigger_set_updated_at();

-- ── broker_phones ──────────────────────────────────────────────────────────
create table if not exists broker_phones (
    id              bigint generated always as identity primary key,
    broker_id       bigint not null references brokers(id) on delete cascade,
    phone           text not null,
    observation_count integer not null default 0,
    first_seen_at   timestamptz,
    last_seen_at    timestamptz
);

create index idx_broker_phones_broker_id on broker_phones(broker_id);
create index idx_broker_phones_phone on broker_phones(phone);

-- ── broker_aliases ─────────────────────────────────────────────────────────
create table if not exists broker_aliases (
    id              bigint generated always as identity primary key,
    broker_id       bigint not null references brokers(id) on delete cascade,
    alias           text not null,
    observation_count integer not null default 0,
    first_seen_at   timestamptz,
    last_seen_at    timestamptz
);

create index idx_broker_aliases_broker_id on broker_aliases(broker_id);
create index idx_broker_aliases_alias on broker_aliases(alias);

-- ── broker_relationships ───────────────────────────────────────────────────
create table if not exists broker_relationships (
    id              bigint generated always as identity primary key,
    source_broker   text not null,
    target_broker   text not null,
    relationship    text not null,
    confidence      numeric default 1.0,
    evidence_count  integer default 1,
    first_seen      timestamptz not null default now(),
    last_seen       timestamptz not null default now(),
    metadata        jsonb default '{}',
    unique(source_broker, target_broker, relationship)
);

-- ── broker_observations ────────────────────────────────────────────────────
create table if not exists broker_observations (
    id              bigint generated always as identity primary key,
    broker_id       bigint not null references brokers(id) on delete cascade,
    parsed_id       bigint not null references parsed_output(id) on delete cascade,
    raw_message_id  bigint not null references raw_messages(id) on delete cascade,
    role            text not null default 'unknown',
    message_type    text,
    group_name      text default '',
    micro_market    text,
    building_name   text,
    landmark_name   text,
    price           numeric,
    bhk             text,
    seen_at         timestamptz
);

create index idx_broker_observations_broker_id on broker_observations(broker_id);
create index idx_broker_observations_parsed_id on broker_observations(parsed_id);

-- ── broker_market_stats ────────────────────────────────────────────────────
create table if not exists broker_market_stats (
    id              bigint generated always as identity primary key,
    broker_id       bigint not null references brokers(id) on delete cascade,
    micro_market    text not null,
    observation_count integer not null default 0,
    listing_count   integer not null default 0,
    requirement_count integer not null default 0,
    avg_ticket      numeric,
    last_seen_at    timestamptz
);

create index idx_broker_market_stats_broker_id on broker_market_stats(broker_id);

-- ── broker_building_stats ──────────────────────────────────────────────────
create table if not exists broker_building_stats (
    id              bigint generated always as identity primary key,
    broker_id       bigint not null references brokers(id) on delete cascade,
    building_name   text not null,
    observation_count integer not null default 0,
    listing_count   integer not null default 0,
    requirement_count integer not null default 0,
    avg_ticket      numeric,
    last_seen_at    timestamptz
);

create index idx_broker_building_stats_broker_id on broker_building_stats(broker_id);

-- ── clients ────────────────────────────────────────────────────────────────
create table if not exists clients (
    id              bigint generated always as identity primary key,
    name            text not null,
    phone           text,
    email           text,
    notes           text default '',
    status          text default 'active',
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index idx_clients_name on clients(name);
create index idx_clients_phone on clients(phone);
create index idx_clients_status on clients(status);

create trigger set_clients_updated_at
    before update on clients
    for each row
    execute function trigger_set_updated_at();

-- ── client_requirements ────────────────────────────────────────────────────
create table if not exists client_requirements (
    id              bigint generated always as identity primary key,
    client_id       bigint not null references clients(id) on delete cascade,
    intent          text not null,
    bhk             text,
    price_min       numeric,
    price_max       numeric,
    micro_market    text,
    building_name   text,
    area_sqft_min   numeric,
    area_sqft_max   numeric,
    furnishing      text,
    use_type        text,
    landmarks       jsonb default '[]',
    must_have       jsonb default '[]',
    nice_to_have    jsonb default '[]',
    notes           text default '',
    is_primary      boolean default true,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index idx_client_requirements_client_id on client_requirements(client_id);

-- ── client_property_candidates ─────────────────────────────────────────────
create table if not exists client_property_candidates (
    id              bigint generated always as identity primary key,
    client_id       bigint not null references clients(id) on delete cascade,
    listing_id      bigint references listings(id) on delete set null,
    message_id      bigint references raw_messages(id) on delete set null,
    building_name   text,
    micro_market    text,
    bhk             text,
    price           numeric,
    price_unit      text,
    area_sqft       numeric,
    furnishing      text,
    confidence      numeric default 0.0,
    match_breakdown jsonb default '{}',
    source_text     text,
    notes           text default '',
    status          text default 'pending',
    availability_status text default 'unknown',
    availability_checked_at timestamptz,
    last_offered_at timestamptz,
    source_timestamp timestamptz,
    created_at      timestamptz not null default now()
);

create index idx_client_candidates_client_id on client_property_candidates(client_id);
create index idx_client_candidates_status on client_property_candidates(status);

-- ── buildings ──────────────────────────────────────────────────────────────
create table if not exists buildings (
    id              bigint generated always as identity primary key,
    building_id     text not null unique,
    canonical_name  text not null,
    micro_market    text,
    address         text,
    developer       text,
    pincode         text,
    latitude        numeric,
    longitude       numeric,
    google_place_id text,
    cts_number      text,
    survey_number   text,
    building_age    text,
    nearby_metro    text,
    nearby_landmarks text,
    nearby_roads    text,
    nearby_buildings text,
    observed_listings      integer default 0,
    observed_brokers       integer default 0,
    observed_requirements  integer default 0,
    last_enriched   timestamptz,
    enrichment_confidence  numeric default 0.0,
    enrichment_sources     jsonb default '[]',
    status          text not null default 'discovered',
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index idx_buildings_building_id on buildings(building_id);
create index idx_buildings_canonical_name on buildings(canonical_name);
create index idx_buildings_micro_market on buildings(micro_market);
create index idx_buildings_status on buildings(status);
create index idx_buildings_google_place_id on buildings(google_place_id) where google_place_id is not null;

create trigger set_buildings_updated_at
    before update on buildings
    for each row
    execute function trigger_set_updated_at();

-- ── building_name_aliases ──────────────────────────────────────────────────
create table if not exists building_name_aliases (
    id              bigint generated always as identity primary key,
    building_id     bigint references buildings(id) on delete cascade,
    alias           text not null unique,
    canonical_name  text not null,
    confidence      numeric default 0.0,
    source          text default 'whatsapp',
    created_at      timestamptz not null default now()
);

create index idx_building_name_aliases_building_id on building_name_aliases(building_id);
create index idx_building_name_aliases_alias on building_name_aliases(alias);

-- ── listing_observations (join table) ──────────────────────────────────────
create table if not exists listing_observations (
    id              bigint generated always as identity primary key,
    listing_id      bigint not null references listings(id) on delete cascade,
    raw_message_id  bigint not null references raw_messages(id) on delete cascade,
    parsed_id       bigint not null references parsed_output(id) on delete cascade,
    group_name      text default '',
    seen_at         timestamptz not null default now(),
    unique(raw_message_id, parsed_id)
);

create index idx_listing_observations_listing_id on listing_observations(listing_id);
create index idx_listing_observations_raw_message_id on listing_observations(raw_message_id);