-- Local Intelligence Lab — SQLite Schema
-- Raw messages are never deleted. Everything else is derived.

CREATE TABLE IF NOT EXISTS raw_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    group_name      TEXT NOT NULL DEFAULT '',
    sender          TEXT NOT NULL DEFAULT '',
    message         TEXT NOT NULL,
    message_type    TEXT NOT NULL DEFAULT 'text',
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
    event_id        TEXT DEFAULT NULL,
    embedding       BLOB DEFAULT NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
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
CREATE INDEX IF NOT EXISTS idx_parsed_raw ON parsed_output(raw_message_id);
-- idx_parsed_intent moved to migration (table may not have intent column yet)
CREATE INDEX IF NOT EXISTS idx_resolver_parsed ON resolver_decisions(parsed_id);
CREATE INDEX IF NOT EXISTS idx_resolver_bid ON resolver_decisions(building_id);
CREATE INDEX IF NOT EXISTS idx_resolver_method ON resolver_decisions(method);
CREATE INDEX IF NOT EXISTS idx_eval_raw ON evaluations(raw_message_id);

