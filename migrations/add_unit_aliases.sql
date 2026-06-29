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
