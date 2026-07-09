-- Local Intelligence Lab — SQLite Schema
-- Raw messages are never deleted. Everything else is derived.

CREATE TABLE IF NOT EXISTS raw_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    group_name      TEXT NOT NULL DEFAULT '',
    sender          TEXT NOT NULL DEFAULT '',
    sender_jid      TEXT DEFAULT '',
    sender_phone    TEXT DEFAULT '',
    message         TEXT NOT NULL,
    message_type    TEXT NOT NULL DEFAULT 'text',
    attachments     TEXT DEFAULT '[]',
    reply_context   TEXT DEFAULT '{}',
    timestamp       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    source          TEXT NOT NULL DEFAULT 'WHATSAPP',
    raw_payload     TEXT DEFAULT '{}',
    message_uid     TEXT DEFAULT NULL,
    pipeline_version TEXT DEFAULT NULL,
    synced_at       TEXT DEFAULT NULL,
    event_id        TEXT DEFAULT NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_msg_uid ON raw_messages(message_uid);

CREATE TABLE IF NOT EXISTS parsed_output (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_message_id  INTEGER NOT NULL REFERENCES raw_messages(id),
    intent          TEXT DEFAULT NULL,
    principal       TEXT DEFAULT NULL,
    bhk             TEXT DEFAULT NULL,
    price           REAL DEFAULT NULL,
    price_unit      TEXT DEFAULT NULL,
    area_sqft       REAL DEFAULT NULL,
    furnishing      TEXT DEFAULT NULL,
    location_raw    TEXT DEFAULT NULL,
    location        TEXT DEFAULT NULL,
    building_name   TEXT DEFAULT NULL,
    landmark_name   TEXT DEFAULT NULL,
    street_name     TEXT DEFAULT NULL,
    area            TEXT DEFAULT NULL,
    micro_market    TEXT DEFAULT NULL,
    developer       TEXT DEFAULT NULL,
    broker_name     TEXT DEFAULT NULL,
    broker_phone    TEXT DEFAULT NULL,
    profile_name    TEXT DEFAULT NULL,
    forwarded       INTEGER DEFAULT 0,
    confidence      REAL DEFAULT 0.0,
    raw_payload     TEXT DEFAULT '{}',
    normalized_message TEXT DEFAULT NULL,
    event_id        TEXT DEFAULT NULL,
    embedding       BLOB DEFAULT NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS listings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint     TEXT NOT NULL UNIQUE,
    intent          TEXT DEFAULT NULL,
    bhk             TEXT DEFAULT NULL,
    price           REAL DEFAULT NULL,
    price_unit      TEXT DEFAULT NULL,
    area_sqft       REAL DEFAULT NULL,
    furnishing      TEXT DEFAULT NULL,
    location_label  TEXT DEFAULT NULL,
    building_name   TEXT DEFAULT NULL,
    landmark_name   TEXT DEFAULT NULL,
    micro_market    TEXT DEFAULT NULL,
    broker_name     TEXT DEFAULT NULL,
    broker_phone    TEXT DEFAULT NULL,
    first_seen      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    last_seen       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    observation_count INTEGER NOT NULL DEFAULT 0,
    group_count     INTEGER NOT NULL DEFAULT 0,
    latest_raw_message_id INTEGER DEFAULT NULL REFERENCES raw_messages(id),
    representative_raw_message_id INTEGER DEFAULT NULL REFERENCES raw_messages(id),
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS listing_observations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id      INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    raw_message_id  INTEGER NOT NULL REFERENCES raw_messages(id) ON DELETE CASCADE,
    parsed_id       INTEGER NOT NULL REFERENCES parsed_output(id) ON DELETE CASCADE,
    group_name      TEXT DEFAULT '',
    seen_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE(raw_message_id)
);

CREATE TABLE IF NOT EXISTS resolver_decisions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    parsed_id       INTEGER NOT NULL REFERENCES parsed_output(id),
    building_id     INTEGER DEFAULT NULL,
    building_name   TEXT DEFAULT NULL,
    landmark_id     TEXT DEFAULT NULL,
    landmark_name   TEXT DEFAULT NULL,
    street_id       TEXT DEFAULT NULL,
    street_name     TEXT DEFAULT NULL,
    project_id      INTEGER DEFAULT NULL,
    project_name    TEXT DEFAULT NULL,
    developer_name  TEXT DEFAULT NULL,
    -- Per-stage confidence
    parser_confidence   REAL DEFAULT 0.0,
    resolver_confidence REAL DEFAULT 0.0,
    final_confidence    REAL DEFAULT 0.0,
    -- Decision details
    method          TEXT DEFAULT 'unresolved',
    method_detail   TEXT DEFAULT NULL,
    -- Candidates (JSON array of { building_id, building_name, confidence, reasons[], landmark_id, distance_m, method })
    candidates      TEXT DEFAULT '[]',
    -- Failure category for unresolved messages
    failure_category TEXT DEFAULT NULL,
    error           TEXT DEFAULT NULL,
    event_id        TEXT DEFAULT NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Parser quality evaluation dataset
CREATE TABLE IF NOT EXISTS evaluations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    raw_message_id  INTEGER NOT NULL REFERENCES raw_messages(id),
    expected_intent       TEXT DEFAULT NULL,
    expected_principal    TEXT DEFAULT NULL,
    expected_bhk         TEXT DEFAULT NULL,
    expected_price       REAL DEFAULT NULL,
    expected_price_unit  TEXT DEFAULT NULL,
    expected_area_sqft   REAL DEFAULT NULL,
    expected_furnishing  TEXT DEFAULT NULL,
    expected_building    TEXT DEFAULT NULL,
    expected_landmark    TEXT DEFAULT NULL,
    expected_street      TEXT DEFAULT NULL,
    expected_area        TEXT DEFAULT NULL,
    expected_micro_market TEXT DEFAULT NULL,
    expected_developer   TEXT DEFAULT NULL,
    expected_broker      TEXT DEFAULT NULL,
    extracted_intent      TEXT DEFAULT NULL,
    extracted_principal   TEXT DEFAULT NULL,
    extracted_bhk         TEXT DEFAULT NULL,
    extracted_price       REAL DEFAULT NULL,
    extracted_price_unit  TEXT DEFAULT NULL,
    extracted_area_sqft   REAL DEFAULT NULL,
    extracted_furnishing  TEXT DEFAULT NULL,
    extracted_building    TEXT DEFAULT NULL,
    extracted_landmark    TEXT DEFAULT NULL,
    extracted_street      TEXT DEFAULT NULL,
    extracted_area        TEXT DEFAULT NULL,
    extracted_micro_market TEXT DEFAULT NULL,
    extracted_developer   TEXT DEFAULT NULL,
    extracted_broker      TEXT DEFAULT NULL,
    accuracy_overall   REAL DEFAULT NULL,
    correction_notes   TEXT DEFAULT NULL,
    evaluated_at       TEXT DEFAULT NULL,
    event_id           TEXT DEFAULT NULL,
    created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Sync checkpoints for historical WhatsApp sync
CREATE TABLE IF NOT EXISTS sync_checkpoints (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_name   TEXT NOT NULL,
    group_jid       TEXT NOT NULL,
    group_name      TEXT DEFAULT '',
    group_owner     TEXT DEFAULT '',
    participants    INTEGER DEFAULT 0,
    last_message_id TEXT DEFAULT NULL,
    last_message_ts TEXT DEFAULT NULL,
    first_message_ts TEXT DEFAULT NULL,
    last_synced_ts  TEXT DEFAULT NULL,
    total_available INTEGER DEFAULT 0,
    synced_count    INTEGER DEFAULT 0,
    status          TEXT DEFAULT 'pending',
    error           TEXT DEFAULT NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE(instance_name, group_jid)
);

-- Source sync jobs (generic, replaces sync_checkpoints for new sources)
CREATE TABLE IF NOT EXISTS source_sync_jobs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    source          TEXT NOT NULL,
    instance        TEXT NOT NULL DEFAULT '',
    group_id        TEXT NOT NULL,
    group_name      TEXT DEFAULT '',
    meta            TEXT DEFAULT '{}',
    status          TEXT DEFAULT 'pending',
    records_found   INTEGER DEFAULT 0,
    records_processed INTEGER DEFAULT 0,
    records_failed  INTEGER DEFAULT 0,
    last_cursor     TEXT DEFAULT NULL,
    error           TEXT DEFAULT NULL,
    started_at      TEXT DEFAULT NULL,
    finished_at     TEXT DEFAULT NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_sj_source ON source_sync_jobs(source);
CREATE INDEX IF NOT EXISTS idx_sj_status ON source_sync_jobs(status);
CREATE INDEX IF NOT EXISTS idx_sj_group ON source_sync_jobs(group_id);

CREATE INDEX IF NOT EXISTS idx_raw_timestamp ON raw_messages(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_raw_group ON raw_messages(group_name);
CREATE INDEX IF NOT EXISTS idx_raw_source ON raw_messages(source);
CREATE INDEX IF NOT EXISTS idx_raw_version ON raw_messages(pipeline_version);
CREATE INDEX IF NOT EXISTS idx_raw_sender_jid ON raw_messages(sender_jid);
CREATE INDEX IF NOT EXISTS idx_raw_sender_phone ON raw_messages(sender_phone);
CREATE INDEX IF NOT EXISTS idx_parsed_raw ON parsed_output(raw_message_id);
CREATE INDEX IF NOT EXISTS idx_listings_fingerprint ON listings(fingerprint);
CREATE INDEX IF NOT EXISTS idx_listings_last_seen ON listings(last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_listing_obs_listing ON listing_observations(listing_id);
CREATE INDEX IF NOT EXISTS idx_listing_obs_raw ON listing_observations(raw_message_id);
-- idx_parsed_intent moved to migration (table may not have intent column yet)
CREATE INDEX IF NOT EXISTS idx_resolver_parsed ON resolver_decisions(parsed_id);
CREATE INDEX IF NOT EXISTS idx_resolver_bid ON resolver_decisions(building_id);
CREATE INDEX IF NOT EXISTS idx_resolver_method ON resolver_decisions(method);
CREATE INDEX IF NOT EXISTS idx_eval_raw ON evaluations(raw_message_id);

-- Broker entity graph
CREATE TABLE IF NOT EXISTS brokers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    identity_key    TEXT NOT NULL UNIQUE,
    canonical_name  TEXT NOT NULL DEFAULT '',
    primary_phone   TEXT DEFAULT NULL,
    first_seen_at   TEXT DEFAULT NULL,
    last_seen_at    TEXT DEFAULT NULL,
    observation_count INTEGER NOT NULL DEFAULT 0,
    listing_count   INTEGER NOT NULL DEFAULT 0,
    requirement_count INTEGER NOT NULL DEFAULT 0,
    rental_count    INTEGER NOT NULL DEFAULT 0,
    commercial_count INTEGER NOT NULL DEFAULT 0,
    group_count     INTEGER NOT NULL DEFAULT 0,
    market_count    INTEGER NOT NULL DEFAULT 0,
    avg_ticket      REAL DEFAULT NULL,
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS broker_phones (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    broker_id       INTEGER NOT NULL REFERENCES brokers(id) ON DELETE CASCADE,
    phone           TEXT NOT NULL,
    observation_count INTEGER NOT NULL DEFAULT 0,
    first_seen_at   TEXT DEFAULT NULL,
    last_seen_at    TEXT DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_bp_broker ON broker_phones(broker_id);

CREATE TABLE IF NOT EXISTS broker_aliases (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    broker_id       INTEGER NOT NULL REFERENCES brokers(id) ON DELETE CASCADE,
    alias           TEXT NOT NULL,
    observation_count INTEGER NOT NULL DEFAULT 0,
    first_seen_at   TEXT DEFAULT NULL,
    last_seen_at    TEXT DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_ba_broker ON broker_aliases(broker_id);

CREATE TABLE IF NOT EXISTS broker_observations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    broker_id       INTEGER NOT NULL REFERENCES brokers(id) ON DELETE CASCADE,
    parsed_id       INTEGER NOT NULL REFERENCES parsed_output(id) ON DELETE CASCADE,
    raw_message_id  INTEGER NOT NULL REFERENCES raw_messages(id) ON DELETE CASCADE,
    role            TEXT NOT NULL DEFAULT 'unknown',
    message_type    TEXT DEFAULT NULL,
    group_name      TEXT DEFAULT '',
    micro_market    TEXT DEFAULT NULL,
    building_name   TEXT DEFAULT NULL,
    landmark_name   TEXT DEFAULT NULL,
    price           REAL DEFAULT NULL,
    bhk             TEXT DEFAULT NULL,
    seen_at         TEXT DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_bo_broker ON broker_observations(broker_id);
CREATE INDEX IF NOT EXISTS idx_bo_parsed ON broker_observations(parsed_id);

CREATE TABLE IF NOT EXISTS broker_market_stats (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    broker_id       INTEGER NOT NULL REFERENCES brokers(id) ON DELETE CASCADE,
    micro_market    TEXT NOT NULL,
    observation_count INTEGER NOT NULL DEFAULT 0,
    listing_count   INTEGER NOT NULL DEFAULT 0,
    requirement_count INTEGER NOT NULL DEFAULT 0,
    avg_ticket      REAL DEFAULT NULL,
    last_seen_at    TEXT DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_bms_broker ON broker_market_stats(broker_id);

CREATE TABLE IF NOT EXISTS broker_building_stats (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    broker_id       INTEGER NOT NULL REFERENCES brokers(id) ON DELETE CASCADE,
    building_name   TEXT NOT NULL,
    observation_count INTEGER NOT NULL DEFAULT 0,
    listing_count   INTEGER NOT NULL DEFAULT 0,
    requirement_count INTEGER NOT NULL DEFAULT 0,
    avg_ticket      REAL DEFAULT NULL,
    last_seen_at    TEXT DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_bbs_broker ON broker_building_stats(broker_id);

-- JID Memory Engine
-- Raw WhatsApp messages remain source of truth. These profiles are derived and rebuildable.
CREATE TABLE IF NOT EXISTS jid_profiles (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    jid_key             TEXT NOT NULL UNIQUE,
    jid                 TEXT DEFAULT '',
    phone               TEXT DEFAULT '',
    display_name        TEXT DEFAULT '',
    message_count       INTEGER NOT NULL DEFAULT 0,
    group_count         INTEGER NOT NULL DEFAULT 0,
    listing_count       INTEGER NOT NULL DEFAULT 0,
    requirement_count   INTEGER NOT NULL DEFAULT 0,
    residential_count   INTEGER NOT NULL DEFAULT 0,
    commercial_count    INTEGER NOT NULL DEFAULT 0,
    sale_count          INTEGER NOT NULL DEFAULT 0,
    rental_count        INTEGER NOT NULL DEFAULT 0,
    first_seen_at       TEXT DEFAULT NULL,
    last_seen_at        TEXT DEFAULT NULL,
    last_message_id     INTEGER DEFAULT NULL REFERENCES raw_messages(id),
    top_localities      TEXT DEFAULT '[]',
    top_buildings       TEXT DEFAULT '[]',
    top_groups          TEXT DEFAULT '[]',
    profile_json        TEXT DEFAULT '{}',
    updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_jid_profiles_phone ON jid_profiles(phone);
CREATE INDEX IF NOT EXISTS idx_jid_profiles_last_seen ON jid_profiles(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS jid_aliases (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    jid_key             TEXT NOT NULL REFERENCES jid_profiles(jid_key) ON DELETE CASCADE,
    alias               TEXT NOT NULL,
    observation_count   INTEGER NOT NULL DEFAULT 0,
    first_seen_at       TEXT DEFAULT NULL,
    last_seen_at        TEXT DEFAULT NULL,
    UNIQUE(jid_key, alias)
);

CREATE INDEX IF NOT EXISTS idx_jid_aliases_key ON jid_aliases(jid_key);

CREATE TABLE IF NOT EXISTS jid_message_index (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    jid_key             TEXT NOT NULL REFERENCES jid_profiles(jid_key) ON DELETE CASCADE,
    raw_message_id      INTEGER NOT NULL REFERENCES raw_messages(id) ON DELETE CASCADE,
    group_name          TEXT DEFAULT '',
    timestamp           TEXT DEFAULT NULL,
    message_kind        TEXT DEFAULT NULL,
    residential_commercial TEXT DEFAULT NULL,
    transaction_type    TEXT DEFAULT NULL,
    bhk                 TEXT DEFAULT NULL,
    budget              REAL DEFAULT NULL,
    budget_unit         TEXT DEFAULT NULL,
    locality            TEXT DEFAULT NULL,
    building_name       TEXT DEFAULT NULL,
    confidence          REAL DEFAULT 0.0,
    metadata_json       TEXT DEFAULT '{}',
    UNIQUE(jid_key, raw_message_id)
);

CREATE INDEX IF NOT EXISTS idx_jmi_jid ON jid_message_index(jid_key);
CREATE INDEX IF NOT EXISTS idx_jmi_raw ON jid_message_index(raw_message_id);
CREATE INDEX IF NOT EXISTS idx_jmi_kind ON jid_message_index(message_kind);
CREATE INDEX IF NOT EXISTS idx_jmi_locality ON jid_message_index(locality);
CREATE INDEX IF NOT EXISTS idx_jmi_building ON jid_message_index(building_name);

-- Token usage log for AI operations
CREATE TABLE IF NOT EXISTS ai_usage_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    agent           TEXT NOT NULL,
    model           TEXT DEFAULT 'gpt-4o-mini',
    tokens_input    INTEGER DEFAULT 0,
    tokens_output   INTEGER DEFAULT 0,
    cost_usd        REAL DEFAULT 0.0,
    source          TEXT DEFAULT 'enrichment',
    source_id       INTEGER DEFAULT NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_aul_agent ON ai_usage_log(agent);
CREATE INDEX IF NOT EXISTS idx_aul_created ON ai_usage_log(created_at);

-- AI suggestion queue — agents propose changes, humans approve/reject
CREATE TABLE IF NOT EXISTS ai_suggestions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    agent           TEXT NOT NULL,
    suggestion_type TEXT NOT NULL,
    title           TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    source_data     TEXT DEFAULT '{}',
    proposal_data   TEXT DEFAULT '{}',
    confidence      REAL DEFAULT 0.0,
    status          TEXT NOT NULL DEFAULT 'pending',
    rejection_reason TEXT DEFAULT NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_ais_status ON ai_suggestions(status);
CREATE INDEX IF NOT EXISTS idx_ais_agent ON ai_suggestions(agent);

-- Enrichment job queue — one per parsed observation, processed after a delay
CREATE TABLE IF NOT EXISTS enrichment_jobs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    parsed_id       INTEGER NOT NULL REFERENCES parsed_output(id),
    raw_message_id  INTEGER NOT NULL REFERENCES raw_messages(id),
    status          TEXT NOT NULL DEFAULT 'pending',
    scheduled_after TEXT NOT NULL,
    attempts        INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    started_at      TEXT,
    completed_at    TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE(parsed_id)
);

CREATE INDEX IF NOT EXISTS idx_ej_status ON enrichment_jobs(status);
CREATE INDEX IF NOT EXISTS idx_ej_scheduled ON enrichment_jobs(scheduled_after);

-- Knowledge graph aliases — learned by AI, applied to future resolutions
CREATE TABLE IF NOT EXISTS location_aliases (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    alias           TEXT NOT NULL UNIQUE,
    canonical       TEXT NOT NULL,
    confidence      REAL DEFAULT 0.0,
    source          TEXT DEFAULT 'ai',
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS building_aliases (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    alias           TEXT NOT NULL UNIQUE,
    canonical       TEXT NOT NULL,
    confidence      REAL DEFAULT 0.0,
    source          TEXT DEFAULT 'ai',
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS broker_aliases_global (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    alias           TEXT NOT NULL UNIQUE,
    canonical       TEXT NOT NULL,
    confidence      REAL DEFAULT 0.0,
    source          TEXT DEFAULT 'ai',
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Price statistics per market + BHK — recomputed periodically
CREATE TABLE IF NOT EXISTS price_stats (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    micro_market    TEXT NOT NULL,
    bhk             TEXT NOT NULL,
    intent          TEXT NOT NULL DEFAULT 'listing',
    median          REAL,
    mean            REAL,
    p5              REAL,
    p25             REAL,
    p75             REAL,
    p95             REAL,
    count           INTEGER NOT NULL DEFAULT 0,
    computed_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE(micro_market, bhk, intent)
);

-- PropAI Companion — official WhatsApp Business mobile interface
CREATE TABLE IF NOT EXISTS companion_team_members (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    mobile_number   TEXT NOT NULL UNIQUE,
    role            TEXT NOT NULL DEFAULT 'sales_agent',
    assigned_markets TEXT DEFAULT '[]',
    active          INTEGER NOT NULL DEFAULT 1,
    waba_identity   TEXT DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_companion_team_mobile ON companion_team_members(mobile_number);
CREATE INDEX IF NOT EXISTS idx_companion_team_active ON companion_team_members(active);

CREATE TABLE IF NOT EXISTS companion_conversations (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    team_member_id  INTEGER REFERENCES companion_team_members(id) ON DELETE SET NULL,
    mobile_number   TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'ai_active',
    context         TEXT DEFAULT '{}',
    last_message_at TEXT DEFAULT NULL,
    pending_reason  TEXT DEFAULT '',
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_companion_conv_mobile ON companion_conversations(mobile_number);
CREATE INDEX IF NOT EXISTS idx_companion_conv_status ON companion_conversations(status);

CREATE TABLE IF NOT EXISTS companion_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER REFERENCES companion_conversations(id) ON DELETE CASCADE,
    direction       TEXT NOT NULL,
    message         TEXT NOT NULL DEFAULT '',
    intent          TEXT DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'received',
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_companion_msg_created ON companion_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_companion_msg_direction ON companion_messages(direction);

CREATE TABLE IF NOT EXISTS companion_audit_log (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    team_member_id  INTEGER REFERENCES companion_team_members(id) ON DELETE SET NULL,
    action          TEXT NOT NULL,
    target_type     TEXT DEFAULT '',
    target_id       TEXT DEFAULT '',
    status          TEXT NOT NULL DEFAULT 'logged',
    details         TEXT DEFAULT '{}',
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_companion_audit_created ON companion_audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_companion_audit_member ON companion_audit_log(team_member_id);

CREATE TABLE IF NOT EXISTS companion_config (
    key             TEXT PRIMARY KEY,
    value           TEXT NOT NULL DEFAULT '',
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- ════════════════════════════════════════════════════════════════════
-- BUILDING ENRICHMENT PIPELINE
-- ════════════════════════════════════════════════════════════════════

-- Canonical building entities with permanent internal ID
CREATE TABLE IF NOT EXISTS buildings (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    building_id     TEXT NOT NULL UNIQUE,  -- BLD-XXXXXXX permanent internal ID
    canonical_name  TEXT NOT NULL,
    micro_market    TEXT,
    address         TEXT,
    developer       TEXT,
    pincode         TEXT,
    latitude        REAL,
    longitude       REAL,
    google_place_id TEXT,
    cts_number      TEXT,
    survey_number   TEXT,
    building_age    TEXT,
    nearby_metro    TEXT,
    nearby_landmarks TEXT,
    nearby_roads    TEXT,
    nearby_buildings TEXT,
    -- Aggregated stats from WhatsApp
    observed_listings   INTEGER DEFAULT 0,
    observed_brokers    INTEGER DEFAULT 0,
    observed_requirements INTEGER DEFAULT 0,
    -- Enrichment metadata
    last_enriched   TEXT,
    enrichment_confidence REAL DEFAULT 0.0,
    enrichment_sources TEXT DEFAULT '[]',  -- JSON array of source names
    -- Status
    status          TEXT NOT NULL DEFAULT 'discovered',  -- discovered, enriching, enriched, failed
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_buildings_canonical ON buildings(canonical_name);
CREATE INDEX IF NOT EXISTS idx_buildings_micro_market ON buildings(micro_market);
CREATE INDEX IF NOT EXISTS idx_buildings_status ON buildings(status);
CREATE INDEX IF NOT EXISTS idx_buildings_building_id ON buildings(building_id);

-- Building aliases (variant names → canonical building)
CREATE TABLE IF NOT EXISTS building_name_aliases (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    building_id     INTEGER REFERENCES buildings(id) ON DELETE CASCADE,
    alias           TEXT NOT NULL UNIQUE,
    canonical_name  TEXT NOT NULL,
    confidence      REAL DEFAULT 0.0,
    source          TEXT DEFAULT 'whatsapp',  -- whatsapp, manual, ai, enrichment
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_building_aliases_alias ON building_name_aliases(alias);
CREATE INDEX IF NOT EXISTS idx_building_aliases_building ON building_name_aliases(building_id);

-- Building enrichment jobs queue
CREATE TABLE IF NOT EXISTS building_enrichment_jobs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    building_id     INTEGER REFERENCES buildings(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'pending',  -- pending, running, completed, failed, skipped
    provider        TEXT NOT NULL,  -- igr, rera, google_places, openstreetmap, manual
    priority        INTEGER DEFAULT 0,  -- higher = processed first
    attempts        INTEGER DEFAULT 0,
    max_attempts    INTEGER DEFAULT 3,
    last_error      TEXT,
    scheduled_after TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    started_at      TEXT,
    completed_at    TEXT,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_building_ej_status ON building_enrichment_jobs(status);
CREATE INDEX IF NOT EXISTS idx_building_ej_building ON building_enrichment_jobs(building_id);
CREATE INDEX IF NOT EXISTS idx_building_ej_scheduled ON building_enrichment_jobs(scheduled_after);
CREATE INDEX IF NOT EXISTS idx_building_ej_provider ON building_enrichment_jobs(provider);

-- Building enrichment source tracking (what data came from where)
CREATE TABLE IF NOT EXISTS building_enrichment_sources (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    building_id     INTEGER REFERENCES buildings(id) ON DELETE CASCADE,
    provider        TEXT NOT NULL,  -- igr, rera, google_places, openstreetmap, manual
    field_name      TEXT NOT NULL,  -- address, developer, latitude, etc.
    field_value     TEXT,
    confidence      REAL DEFAULT 0.0,
    source_url      TEXT,
    source_record_id TEXT,
    enriched_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE(building_id, provider, field_name)
);

CREATE INDEX IF NOT EXISTS idx_building_es_building ON building_enrichment_sources(building_id);
CREATE INDEX IF NOT EXISTS idx_building_es_provider ON building_enrichment_sources(provider);

-- Building enrichment history (audit trail)
CREATE TABLE IF NOT EXISTS building_enrichment_history (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    building_id     INTEGER REFERENCES buildings(id) ON DELETE CASCADE,
    job_id          INTEGER REFERENCES building_enrichment_jobs(id) ON DELETE SET NULL,
    provider        TEXT NOT NULL,
    action          TEXT NOT NULL,  -- discovered, enriched, updated, failed, skipped
    fields_updated  TEXT DEFAULT '[]',  -- JSON array of field names
    confidence      REAL DEFAULT 0.0,
    details         TEXT DEFAULT '{}',
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_building_eh_building ON building_enrichment_history(building_id);
CREATE INDEX IF NOT EXISTS idx_building_eh_created ON building_enrichment_history(created_at);

-- Requirement-Listing matches (pre-computed for fast retrieval)
CREATE TABLE IF NOT EXISTS requirement_matches (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    requirement_id  INTEGER NOT NULL REFERENCES parsed_output(id) ON DELETE CASCADE,
    listing_id      INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
    match_score     REAL NOT NULL DEFAULT 0.0,  -- 0-100 fit score
    bhk_match       INTEGER DEFAULT 0,  -- 1=exact, 0.5=±1, 0=mismatch
    market_match    INTEGER DEFAULT 0,  -- 1=exact, 0=no match
    price_match     REAL DEFAULT 0.0,   -- 0-1 how close price fits
    building_match  INTEGER DEFAULT 0,  -- 1=same building, 0=different
    intent_match    INTEGER DEFAULT 0,  -- 1=matching intent, 0=mismatch
    matched_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE(requirement_id, listing_id)
);

CREATE INDEX IF NOT EXISTS idx_rm_requirement ON requirement_matches(requirement_id);
CREATE INDEX IF NOT EXISTS idx_rm_listing ON requirement_matches(listing_id);
CREATE INDEX IF NOT EXISTS idx_rm_score ON requirement_matches(match_score DESC);

-- Price unit aliases for normalization
-- L = Lac = Lakh = Lacs = Lakhs
-- Cr = Crore = Karod = Cror = Crores = Karods
-- K = Thousand = Hazaar = 000

CREATE TABLE IF NOT EXISTS price_unit_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alias TEXT NOT NULL UNIQUE,
    canonical_unit TEXT NOT NULL,  -- 'L', 'Cr', 'K', 'abs'
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_price_unit_aliases_alias ON price_unit_aliases(alias);
CREATE INDEX IF NOT EXISTS idx_price_unit_aliases_canonical ON price_unit_aliases(canonical_unit);
