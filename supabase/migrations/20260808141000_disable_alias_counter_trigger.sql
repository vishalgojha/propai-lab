-- Alias creation is on the extraction hot path.  The old trigger recomputed
-- observed listing counts across every building and typed table on each alias
-- upsert, causing statement timeouts.  Counter maintenance remains available
-- through the explicit recompute function, but must not block ingestion.
drop trigger if exists trg_refresh_building_observed_listings_aliases
on public.building_name_aliases;
