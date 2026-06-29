-- ============================================================
-- KNOWLEDGE-CENTRIC SCHEMA
-- Architecture: WhatsApp → Knowledge Records → FTS + Vector → AI
-- ============================================================

-- Core knowledge store
CREATE TABLE IF NOT EXISTS knowledge_records (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    
    -- Source identification
    source_type     TEXT NOT NULL,  -- 'whatsapp', 'dm', 'email', 'csv', 'voice', 'web'
    source_id       TEXT,           -- External ID (message_id, email_id, etc.)
    
    -- Content
    raw_content     TEXT NOT NULL,  -- Original unprocessed content
    processed_content TEXT,         -- Cleaned/normalized content
    
    -- People
    sender_jid      TEXT,           -- WhatsApp JID or email address
    sender_name     TEXT,           -- Display name
    sender_phone    TEXT,           -- Phone number (canonical identity)
    
    -- Context
    conversation_id TEXT,           -- Group JID, chat ID, thread ID
    conversation_name TEXT,         -- Human-readable conversation name
    
    -- Timing
    message_timestamp TEXT NOT NULL, -- When the message was sent
    ingested_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    
    -- Classification (AI-assigned, not parser-assigned)
    content_type    TEXT DEFAULT 'unknown', -- 'listing', 'requirement', 'inquiry', 'notification', 'social', 'unknown'
    intent          TEXT,           -- 'SELL', 'BUY', 'RENT', 'RENTAL_SEEKER', 'INQUIRY', etc.
    
    -- Embedding reference
    embedding_id    TEXT,           -- Reference to vector embedding
    
    -- Metadata (flexible JSON for anything extra)
    metadata        TEXT DEFAULT '{}',  -- JSON blob for extensibility
    
    -- Quality
    confidence      REAL DEFAULT 0.0,   -- AI confidence in classification
    is_valid        INTEGER DEFAULT 1,  -- Soft delete flag
    
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Tags for flexible classification
CREATE TABLE IF NOT EXISTS knowledge_tags (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id       INTEGER NOT NULL REFERENCES knowledge_records(id) ON DELETE CASCADE,
    tag_type        TEXT NOT NULL,  -- 'building', 'market', 'bhk', 'price_range', 'furnishing', 'property_type', etc.
    tag_value       TEXT NOT NULL,  -- The actual tag value
    confidence      REAL DEFAULT 1.0,
    source          TEXT DEFAULT 'system', -- 'system', 'ai', 'user'
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Aliases for building/market name normalization
CREATE TABLE IF NOT EXISTS knowledge_aliases (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    alias           TEXT NOT NULL,
    canonical       TEXT NOT NULL,  -- The canonical form
    entity_type     TEXT NOT NULL,  -- 'building', 'market', 'landmark', 'broker', etc.
    confidence      REAL DEFAULT 1.0,
    source          TEXT DEFAULT 'system',
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    UNIQUE(alias, entity_type)
);

-- Learning queue for unknown terms
CREATE TABLE IF NOT EXISTS learning_cards (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    term            TEXT NOT NULL,
    context         TEXT DEFAULT '',  -- Where this term was found
    frequency       INTEGER DEFAULT 1,
    first_seen      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    last_seen       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    
    -- Resolution
    status          TEXT DEFAULT 'pending',  -- 'pending', 'resolved', 'ignored'
    resolved_type   TEXT,           -- 'building', 'market', 'landmark', 'person', 'other'
    resolved_value  TEXT,           -- The canonical value if resolved
    resolved_by     TEXT,           -- 'user', 'ai', 'system'
    resolved_at     TEXT,
    
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Broker relationships (who knows whom)
CREATE TABLE IF NOT EXISTS broker_relationships (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    source_broker   TEXT NOT NULL,  -- Phone or JID of source broker
    target_broker   TEXT NOT NULL,  -- Phone or JID of target broker
    relationship    TEXT NOT NULL,  -- 'referral', 'colleague', 'client', 'owner', 'tenant', etc.
    confidence      REAL DEFAULT 1.0,
    evidence_count  INTEGER DEFAULT 1,
    first_seen      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    last_seen       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    metadata        TEXT DEFAULT '{}',
    UNIQUE(source_broker, target_broker, relationship)
);

-- Conversation index (for tracking group dynamics)
CREATE TABLE IF NOT EXISTS conversation_index (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,  -- Group JID or chat ID
    conversation_name TEXT,
    message_count   INTEGER DEFAULT 0,
    participant_count INTEGER DEFAULT 0,
    first_message   TEXT,
    last_message    TEXT,
    last_activity   TEXT,
    metadata        TEXT DEFAULT '{}',
    UNIQUE(conversation_id)
);

-- Embeddings table (for vector search)
CREATE TABLE IF NOT EXISTS embeddings (
    id              TEXT PRIMARY KEY,  -- UUID
    record_id       INTEGER REFERENCES knowledge_records(id) ON DELETE CASCADE,
    model           TEXT NOT NULL,     -- e.g., 'text-embedding-3-small'
    embedding       BLOB NOT NULL,     -- Vector as binary blob
    dimensions      INTEGER NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Indexes for fast retrieval
CREATE INDEX IF NOT EXISTS idx_kr_source ON knowledge_records(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_kr_sender ON knowledge_records(sender_jid);
CREATE INDEX IF NOT EXISTS idx_kr_sender_phone ON knowledge_records(sender_phone);
CREATE INDEX IF NOT EXISTS idx_kr_conversation ON knowledge_records(conversation_id);
CREATE INDEX IF NOT EXISTS idx_kr_timestamp ON knowledge_records(message_timestamp);
CREATE INDEX IF NOT EXISTS idx_kr_content_type ON knowledge_records(content_type);
CREATE INDEX IF NOT EXISTS idx_kr_intent ON knowledge_records(intent);
CREATE INDEX IF NOT EXISTS idx_kr_ingested ON knowledge_records(ingested_at);

CREATE INDEX IF NOT EXISTS idx_kt_record ON knowledge_tags(record_id);
CREATE INDEX IF NOT EXISTS idx_kt_type_value ON knowledge_tags(tag_type, tag_value);

CREATE INDEX IF NOT EXISTS idx_ka_alias ON knowledge_aliases(alias);
CREATE INDEX IF NOT EXISTS idx_ka_canonical ON knowledge_aliases(canonical);

CREATE INDEX IF NOT EXISTS idx_lc_status ON learning_cards(status);
CREATE INDEX IF NOT EXISTS idx_lc_frequency ON learning_cards(frequency DESC);

CREATE INDEX IF NOT EXISTS idx_br_source ON broker_relationships(source_broker);
CREATE INDEX IF NOT EXISTS idx_br_target ON broker_relationships(target_broker);

CREATE INDEX IF NOT EXISTS idx_emb_record ON embeddings(record_id);

-- Full-text search on knowledge records
CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_records_fts USING fts5(
    raw_content,
    processed_content,
    sender_name,
    conversation_name,
    content='knowledge_records',
    content_rowid='id',
    tokenize='porter unicode61'
);

-- Triggers to keep FTS in sync
CREATE TRIGGER IF NOT EXISTS knowledge_records_ai AFTER INSERT ON knowledge_records BEGIN
    INSERT INTO knowledge_records_fts(rowid, raw_content, processed_content, sender_name, conversation_name)
    VALUES (new.id, new.raw_content, new.processed_content, new.sender_name, new.conversation_name);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_records_ad AFTER DELETE ON knowledge_records BEGIN
    INSERT INTO knowledge_records_fts(knowledge_records_fts, rowid, raw_content, processed_content, sender_name, conversation_name)
    VALUES ('delete', old.id, old.raw_content, old.processed_content, old.sender_name, old.conversation_name);
END;

CREATE TRIGGER IF NOT EXISTS knowledge_records_au AFTER UPDATE ON knowledge_records BEGIN
    INSERT INTO knowledge_records_fts(knowledge_records_fts, rowid, raw_content, processed_content, sender_name, conversation_name)
    VALUES ('delete', old.id, old.raw_content, old.processed_content, old.sender_name, old.conversation_name);
    INSERT INTO knowledge_records_fts(rowid, raw_content, processed_content, sender_name, conversation_name)
    VALUES (new.id, new.raw_content, new.processed_content, new.sender_name, new.conversation_name);
END;

-- Stats view
CREATE VIEW IF NOT EXISTS v_knowledge_stats AS
SELECT
    source_type,
    content_type,
    intent,
    COUNT(*) as record_count,
    COUNT(DISTINCT sender_jid) as unique_senders,
    COUNT(DISTINCT conversation_id) as unique_conversations,
    MIN(message_timestamp) as earliest,
    MAX(message_timestamp) as latest
FROM knowledge_records
WHERE is_valid = 1
GROUP BY source_type, content_type, intent;
