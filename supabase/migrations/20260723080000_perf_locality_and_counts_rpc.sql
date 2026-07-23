CREATE OR REPLACE FUNCTION get_locality_counts()
RETURNS TABLE (
  micro_market text,
  listing_count bigint
)
LANGUAGE sql STABLE
AS $$
  SELECT 
    micro_market,
    count(*) as listing_count
  FROM listings
  WHERE micro_market IS NOT NULL AND micro_market != ''
  GROUP BY micro_market
  ORDER BY listing_count DESC;
$$;

CREATE OR REPLACE FUNCTION get_public_counts()
RETURNS TABLE (
  listings_total bigint,
  listings_active_30d bigint,
  brokers bigint,
  localities bigint,
  raw_messages bigint,
  buildings bigint
)
LANGUAGE sql STABLE
AS $$
  SELECT
    (SELECT count(*) FROM listings) as listings_total,
    (SELECT count(*) FROM listings WHERE last_seen >= now() - interval '30 days') as listings_active_30d,
    (SELECT count(*) FROM brokers) as brokers,
    (SELECT count(DISTINCT micro_market) FROM listings WHERE micro_market IS NOT NULL AND micro_market != '') as localities,
    (SELECT count(*) FROM raw_messages) as raw_messages,
    (SELECT count(*) FROM buildings) as buildings;
$$;
