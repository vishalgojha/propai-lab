-- =================================================================
-- PropAI Evidence Engine — Database Schema
-- =================================================================
-- Design principles:
--   1. Registry is immutable (canonical_buildings never rebuilt)
--   2. Evidence is append-only (never UPDATE or DELETE observations)
--   3. Intelligence is derived (never store computed metrics)
-- =================================================================

-- ── Extensions ─────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =================================================================
-- CANONICAL REGISTRY (read-only reference)
-- =================================================================
-- This table is populated once by Registry v1 and never rebuilt.
-- Subsequent scrapers enrich via building_evidence, never by
-- modifying this table directly.

CREATE TABLE IF NOT EXISTS canonical_buildings (
    building_id         SERIAL PRIMARY KEY,
    fingerprint         VARCHAR(16) UNIQUE NOT NULL,
    canonical_name      VARCHAR(255) NOT NULL,
    area                VARCHAR(255) NOT NULL DEFAULT '',
    micro_market        VARCHAR(255) NOT NULL DEFAULT '',
    latitude            DOUBLE PRECISION,
    longitude           DOUBLE PRECISION,
    pincode             VARCHAR(10),
    developer           VARCHAR(255),
    confidence_score    INTEGER NOT NULL DEFAULT 0,
    health_score        INTEGER NOT NULL DEFAULT 0,
    status              VARCHAR(50) NOT NULL DEFAULT 'Active',
    first_seen          DATE NOT NULL DEFAULT CURRENT_DATE,
    last_seen           DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE INDEX idx_buildings_fingerprint ON canonical_buildings (fingerprint);
CREATE INDEX idx_buildings_area       ON canonical_buildings (area);
CREATE INDEX idx_buildings_micro_market ON canonical_buildings (micro_market);

-- ── Building aliases ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS building_aliases (
    id              SERIAL PRIMARY KEY,
    building_id     INTEGER NOT NULL REFERENCES canonical_buildings(building_id),
    alias           VARCHAR(255) NOT NULL,
    canonical_name  VARCHAR(255) NOT NULL
);

CREATE INDEX idx_aliases_building ON building_aliases (building_id);
CREATE INDEX idx_aliases_name     ON building_aliases (alias);

-- =================================================================
-- STREET REGISTRY
-- =================================================================
-- Streets are canonical entities alongside buildings.
-- Every building sits on one or more streets.

CREATE TABLE IF NOT EXISTS streets (
    street_id           VARCHAR(10) PRIMARY KEY,  -- ST-001 format
    name                VARCHAR(255) NOT NULL,
    aliases             TEXT[],                    -- alternative names
    micro_market        VARCHAR(255) NOT NULL DEFAULT '',
    pincodes            TEXT[],
    lat_start           DOUBLE PRECISION,
    lng_start           DOUBLE PRECISION,
    lat_end             DOUBLE PRECISION,
    lng_end             DOUBLE PRECISION,
    source              VARCHAR(50) NOT NULL DEFAULT 'manual',
    created_at          DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE INDEX idx_streets_name     ON streets (name);
CREATE INDEX idx_streets_mm       ON streets (micro_market);

-- ── Building → Street (many-to-many) ────────────────────────────
CREATE TABLE IF NOT EXISTS building_streets (
    id              SERIAL PRIMARY KEY,
    building_id     INTEGER NOT NULL REFERENCES canonical_buildings(building_id),
    street_id       VARCHAR(10) NOT NULL REFERENCES streets(street_id),
    distance_m      INTEGER,  -- approximate distance in meters (optional)
    UNIQUE (building_id, street_id)
);

CREATE INDEX idx_bs_building ON building_streets (building_id);
CREATE INDEX idx_bs_street   ON building_streets (street_id);

-- =================================================================
-- LANDMARK REGISTRY
-- =================================================================
-- Landmarks sit above Streets in the location graph hierarchy.
-- Mumbai broker vocabulary references landmarks (malls, hospitals,
-- railway stations) far more often than street names.
-- Layout: City → Zone → Micro Market → Landmark → Street → Building

CREATE TABLE IF NOT EXISTS landmarks (
    landmark_id     VARCHAR(10) PRIMARY KEY,  -- LM-001 format
    name            VARCHAR(255) NOT NULL,
    aliases         TEXT[],                    -- alternative names
    type            VARCHAR(50) NOT NULL,      -- Mall, Hospital, Railway Station, etc.
    micro_market    VARCHAR(255) NOT NULL DEFAULT '',
    latitude        DOUBLE PRECISION,
    longitude       DOUBLE PRECISION,
    importance      INTEGER NOT NULL DEFAULT 0 CHECK (importance >= 0 AND importance <= 100),
    source          VARCHAR(50) NOT NULL DEFAULT 'manual',
    created_at      DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE INDEX idx_landmarks_name     ON landmarks (name);
CREATE INDEX idx_landmarks_type     ON landmarks (type);
CREATE INDEX idx_landmarks_mm       ON landmarks (micro_market);

-- ── Building → Landmark proximity ───────────────────────────────
CREATE TABLE IF NOT EXISTS building_landmarks (
    id              SERIAL PRIMARY KEY,
    building_id     INTEGER NOT NULL REFERENCES canonical_buildings(building_id),
    landmark_id     VARCHAR(10) NOT NULL REFERENCES landmarks(landmark_id),
    distance_m      INTEGER NOT NULL,           -- straight-line distance in meters
    walking_min     INTEGER NOT NULL DEFAULT 1,  -- estimated walking minutes
    UNIQUE (building_id, landmark_id)
);

CREATE INDEX idx_bl_building  ON building_landmarks (building_id);
CREATE INDEX idx_bl_landmark  ON building_landmarks (landmark_id);

-- ── Location Graph ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS location_graph (
    entity_type     VARCHAR(50) NOT NULL,  -- city, zone, micro_market, street
    name            VARCHAR(255) NOT NULL,
    parent_type     VARCHAR(50),           -- parent entity type
    parent_name     VARCHAR(255),          -- parent entity name
    PRIMARY KEY (entity_type, name)
);

-- Populated from data/location_graph.csv

-- ── Developer Registry ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS developers (
    developer_id        SERIAL PRIMARY KEY,
    canonical_name      VARCHAR(255) NOT NULL UNIQUE,
    aliases             TEXT[],                    -- alternative names / spellings
    project_count       INTEGER NOT NULL DEFAULT 0,
    resolved_buildings  INTEGER NOT NULL DEFAULT 0,
    first_seen          DATE NOT NULL DEFAULT CURRENT_DATE,
    last_seen           DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE INDEX idx_developers_name ON developers (canonical_name);

-- ── Developer → Street relationships ────────────────────────────
CREATE TABLE IF NOT EXISTS developer_streets (
    id              SERIAL PRIMARY KEY,
    developer_id    INTEGER NOT NULL REFERENCES developers(developer_id),
    street_id       VARCHAR(10) NOT NULL REFERENCES streets(street_id),
    project_count   INTEGER NOT NULL DEFAULT 0,
    UNIQUE (developer_id, street_id)
);

CREATE INDEX idx_ds_developer ON developer_streets (developer_id);
CREATE INDEX idx_ds_street    ON developer_streets (street_id);

-- ── Project Registry ────────────────────────────────────────────
-- Canonical entity: Developer → Project(s) → Building(s).
-- A single project (RERA#) can span multiple buildings (phases/towers).
CREATE TABLE IF NOT EXISTS projects (
    project_id          SERIAL PRIMARY KEY,
    rera_no             VARCHAR(50) NOT NULL UNIQUE,
    project_name        VARCHAR(500) NOT NULL,
    developer_name      VARCHAR(255),
    developer_id        INTEGER REFERENCES developers(developer_id),
    building_ids        INTEGER[] NOT NULL DEFAULT '{}',  -- one-to-many
    location            VARCHAR(500),
    district            VARCHAR(100),
    pincode             VARCHAR(10),
    resolution_confidence REAL NOT NULL DEFAULT 0.0,
    resolution_method   VARCHAR(50),
    last_modified       DATE,
    first_seen          DATE NOT NULL DEFAULT CURRENT_DATE,
    last_seen           DATE NOT NULL DEFAULT CURRENT_DATE
);

CREATE INDEX idx_projects_rera      ON projects (rera_no);
CREATE INDEX idx_projects_developer ON projects (developer_id);
CREATE INDEX idx_projects_name      ON projects (project_name);

-- =================================================================
-- OBSERVATIONS (append-only evidence)
-- =================================================================

CREATE TABLE IF NOT EXISTS building_observations (
    observation_id      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    building_id         INTEGER NOT NULL REFERENCES canonical_buildings(building_id),
    observation_type    VARCHAR(50) NOT NULL CHECK (
                            observation_type IN (
                                'SALE_LISTING', 'RENT_LISTING',
                                'BROKER_REQUIREMENT', 'BROKER_OFFER',
                                'IGR_TRANSACTION', 'MAHARERA_PROJECT',
                                'PRICE_CHANGE', 'STATUS_CHANGE',
                                'BROKER_MENTION', 'IMAGE_UPDATE',
                                'AMENITY_UPDATE', 'MANUAL_CORRECTION'
                            )
                        ),
    source              VARCHAR(50) NOT NULL CHECK (
                            source IN (
                                'PROPi', 'HOUSING', 'MAGICBRICKS',
                                '99ACRES', 'MAHARERA', 'IGR',
                                'WHATSAPP', 'MANUAL'
                            )
                        ),
    observed_at         TIMESTAMPTZ NOT NULL,   -- When the event occurred
    payload             JSONB NOT NULL DEFAULT '{}',  -- Flexible event payload
    confidence          REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
    source_reference    VARCHAR(500),             -- URL, message ID, deed number
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- When ingested

    -- Prevent duplicate observations (same source + same reference)
    UNIQUE (source, source_reference)
);

-- Indexes for temporal queries
CREATE INDEX idx_obs_building     ON building_observations (building_id);
CREATE INDEX idx_obs_type         ON building_observations (observation_type);
CREATE INDEX idx_obs_observed_at  ON building_observations (observed_at DESC);
CREATE INDEX idx_obs_source       ON building_observations (source);
CREATE INDEX idx_obs_payload      ON building_observations USING GIN (payload);

-- Composite index for common query pattern:
-- "What SALE_LISTINGs exist for building X in the last 90 days?"
CREATE INDEX idx_obs_building_type_time
    ON building_observations (building_id, observation_type, observed_at DESC);

-- ── Observation sources (tracks metadata per source scrape) ────
CREATE TABLE IF NOT EXISTS observation_sources (
    source_id       SERIAL PRIMARY KEY,
    source          VARCHAR(50) NOT NULL,
    source_url      VARCHAR(500),
    scraped_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    records_found   INTEGER NOT NULL DEFAULT 0,
    records_ingested INTEGER NOT NULL DEFAULT 0,
    records_failed  INTEGER NOT NULL DEFAULT 0,
    status          VARCHAR(50) NOT NULL DEFAULT 'completed',
    error_message   TEXT,
    duration_ms     INTEGER
);

CREATE INDEX idx_src_source    ON observation_sources (source);
CREATE INDEX idx_src_scraped   ON observation_sources (scraped_at DESC);

-- =================================================================
-- UNRESOLVED OBSERVATIONS
-- =================================================================
-- Observations where BuildingID could not be determined.
-- These are retried automatically as the registry grows.

CREATE TABLE IF NOT EXISTS unresolved_observations (
    unresolved_id       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    raw_building_name   VARCHAR(500) NOT NULL,
    raw_area            VARCHAR(255),
    observation_type    VARCHAR(50) NOT NULL,
    source              VARCHAR(50) NOT NULL,
    observed_at         TIMESTAMPTZ NOT NULL,
    payload             JSONB NOT NULL DEFAULT '{}',
    raw_source_data     JSONB NOT NULL DEFAULT '{}',
    confidence          REAL NOT NULL DEFAULT 0.0,
    source_reference    VARCHAR(500),
    resolve_attempts    INTEGER NOT NULL DEFAULT 0,
    status              VARCHAR(50) NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'resolved', 'discarded')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_unresolved_status ON unresolved_observations (status);
CREATE INDEX idx_unresolved_source  ON unresolved_observations (source);
CREATE INDEX idx_unresolved_name    ON unresolved_observations (raw_building_name);

-- =================================================================
-- OBSERVATION HISTORY (audit trail for the audit trail)
-- =================================================================
-- Tracks all changes to observations (rare — only for MANUAL_CORRECTION
-- or status changes). Most observations are insert-only.

CREATE TABLE IF NOT EXISTS observation_history (
    history_id          SERIAL PRIMARY KEY,
    observation_id      UUID NOT NULL REFERENCES building_observations(observation_id),
    changed_field       VARCHAR(100) NOT NULL,
    old_value           TEXT,
    new_value           TEXT,
    changed_by          VARCHAR(100) NOT NULL DEFAULT 'system',
    changed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_history_obs ON observation_history (observation_id);

-- =================================================================
-- NORMALIZATION STRATEGIES (knowledge base snapshot)
-- =================================================================
-- Mirrors the YAML knowledge base for use in SQL-level resolution.

CREATE TABLE IF NOT EXISTS normalization_strategies (
    strategy_id     VARCHAR(10) PRIMARY KEY,
    classification  VARCHAR(50) NOT NULL,
    description     TEXT NOT NULL,
    pattern_type    VARCHAR(50) NOT NULL,
    pattern_regex   TEXT,
    confidence      REAL NOT NULL DEFAULT 0.9,
    false_positive_risk VARCHAR(20) NOT NULL DEFAULT 'medium',
    auto_apply      BOOLEAN NOT NULL DEFAULT false,
    source_applies  TEXT[],   -- array of source names
    source_excludes TEXT[],
    history_applied INTEGER NOT NULL DEFAULT 0,
    history_rejected INTEGER NOT NULL DEFAULT 0,
    created_at      DATE NOT NULL DEFAULT CURRENT_DATE
);

-- =================================================================
-- NEGATIVE KNOWLEDGE
-- =================================================================
-- Known-distinct building pairs — the resolver checks these before
-- suggesting a merge.

CREATE TABLE IF NOT EXISTS negative_knowledge (
    id              SERIAL PRIMARY KEY,
    name_a          VARCHAR(255) NOT NULL,
    name_b          VARCHAR(255) NOT NULL,
    area            VARCHAR(255),
    developer       VARCHAR(255),
    evidence        TEXT,
    source          VARCHAR(100),
    created_at      DATE NOT NULL DEFAULT CURRENT_DATE,
    UNIQUE (name_a, name_b, COALESCE(area, ''))
);

CREATE INDEX idx_negative_names ON negative_knowledge (name_a, name_b);

-- =================================================================
-- VIEW: Latest observation per building per type
-- =================================================================
-- Useful for "what's the current status" queries without storing
-- derived state.

CREATE VIEW building_latest_observations AS
SELECT DISTINCT ON (building_id, observation_type)
    building_id,
    observation_type,
    observation_id,
    source,
    observed_at,
    payload,
    confidence,
    source_reference,
    created_at
FROM building_observations
ORDER BY building_id, observation_type, observed_at DESC;

-- =================================================================
-- VIEW: Building health summary
-- =================================================================
-- Real-time health scores based on actual evidence, not just
-- initial enrichment.

CREATE VIEW building_health_evidence AS
SELECT
    b.building_id,
    b.canonical_name,
    b.health_score AS initial_health,
    COUNT(DISTINCT o.observation_id) AS total_observations,
    COUNT(DISTINCT o.observation_type) AS unique_observation_types,
    COUNT(DISTINCT o.source) AS evidence_sources,
    MAX(o.observed_at) AS last_observed,
    COUNT(DISTINCT u.unresolved_id) AS unresolved_count
FROM canonical_buildings b
LEFT JOIN building_observations o ON b.building_id = o.building_id
LEFT JOIN unresolved_observations u ON u.raw_building_name = b.canonical_name
GROUP BY b.building_id, b.canonical_name, b.health_score;
