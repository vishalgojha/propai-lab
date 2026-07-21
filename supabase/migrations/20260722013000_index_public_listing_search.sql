-- Public search never needs to transfer the entire listings table to Next.js.
-- These trigram indexes support the candidate lookups in apps/www/src/lib/
-- natural-search.ts, including partial building and locality names such as
-- "ten bkc".  They are read-only indexes; no RLS or API exposure changes.

create extension if not exists pg_trgm;

create index if not exists idx_listings_building_name_trgm
  on public.listings using gin (lower(coalesce(building_name, '')) gin_trgm_ops);

create index if not exists idx_listings_micro_market_trgm
  on public.listings using gin (lower(coalesce(micro_market, '')) gin_trgm_ops);

create index if not exists idx_listings_location_label_trgm
  on public.listings using gin (lower(coalesce(location_label, '')) gin_trgm_ops);

create index if not exists idx_listings_landmark_name_trgm
  on public.listings using gin (lower(coalesce(landmark_name, '')) gin_trgm_ops);
