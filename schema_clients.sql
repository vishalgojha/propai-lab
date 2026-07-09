-- Client Management for PropAI Context Actions

-- Clients: brokers' buyers/tenants they're working with
CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    notes TEXT DEFAULT '',
    status TEXT DEFAULT 'active',  -- active, inactive, closed
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_clients_name ON clients(name);
CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone);
CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);

-- Client Requirements: what each client is looking for
CREATE TABLE IF NOT EXISTS client_requirements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    intent TEXT NOT NULL,  -- BUY, RENT
    bhk TEXT,
    price_min REAL,
    price_max REAL,
    micro_market TEXT,
    building_name TEXT,
    area_sqft_min REAL,
    area_sqft_max REAL,
    furnishing TEXT,
    use_type TEXT,  -- residential, commercial, retail, office
    landmarks TEXT,  -- JSON array of preferred landmarks
    must_have TEXT,  -- JSON array of must-have features
    nice_to_have TEXT,  -- JSON array of nice-to-have features
    notes TEXT DEFAULT '',
    is_primary INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_client_req_client ON client_requirements(client_id);
CREATE INDEX IF NOT EXISTS idx_client_req_intent ON client_requirements(intent);

-- Client Property Candidates: listings saved to a client's bucket
CREATE TABLE IF NOT EXISTS client_property_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL,
    listing_id INTEGER,
    message_id INTEGER,
    building_name TEXT,
    micro_market TEXT,
    bhk TEXT,
    price REAL,
    price_unit TEXT,
    area_sqft REAL,
    furnishing TEXT,
    confidence REAL DEFAULT 0.0,  -- AI compatibility score 0-100
    match_breakdown TEXT DEFAULT '{}',  -- JSON: {budget: true, area: true, location: true, ...}
    source_text TEXT,  -- the original selected text
    notes TEXT DEFAULT '',
    status TEXT DEFAULT 'pending',  -- pending, viewed, shortlisted, rejected, offered
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
    FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE SET NULL,
    FOREIGN KEY (message_id) REFERENCES raw_messages(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_client_candidates_client ON client_property_candidates(client_id);
CREATE INDEX IF NOT EXISTS idx_client_candidates_listing ON client_property_candidates(listing_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_client_candidates_unique ON client_property_candidates(client_id, listing_id);

-- Follow-ups: reminders for broker actions
CREATE TABLE IF NOT EXISTS follow_ups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER,
    message_id INTEGER,
    building_name TEXT,
    broker_phone TEXT,
    follow_up_type TEXT NOT NULL,  -- call, visit, negotiation, payment, other
    title TEXT NOT NULL,
    notes TEXT DEFAULT '',
    due_date TEXT NOT NULL,
    due_time TEXT,
    status TEXT DEFAULT 'pending',  -- pending, done, cancelled
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL,
    FOREIGN KEY (message_id) REFERENCES raw_messages(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_follow_ups_client ON follow_ups(client_id);
CREATE INDEX IF NOT EXISTS idx_follow_ups_due ON follow_ups(due_date, status);
