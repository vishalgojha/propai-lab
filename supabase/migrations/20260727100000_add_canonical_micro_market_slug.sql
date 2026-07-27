-- Add canonical_micro_market_slug column to listings and buildings.
-- This column stores the pre-computed canonical slug for each row's micro_market,
-- enabling O(1) lookups instead of scanning all 82k+ rows on every locality page request.

ALTER TABLE listings ADD COLUMN IF NOT EXISTS canonical_micro_market_slug text;
ALTER TABLE buildings ADD COLUMN IF NOT EXISTS canonical_micro_market_slug text;

-- Indexes for the new column — critical for the locality page query path.
CREATE INDEX IF NOT EXISTS idx_listings_canonical_micro_market_slug
  ON listings (canonical_micro_market_slug)
  WHERE canonical_micro_market_slug IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_buildings_canonical_micro_market_slug
  ON buildings (canonical_micro_market_slug)
  WHERE canonical_micro_market_slug IS NOT NULL;
