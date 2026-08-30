-- The expression indexes below are redundant with the *_locality_fresh
-- indexes, which are the indexes selected by current locality query plans.
-- The shorter locality_id indexes are retained; the generated duplicates are
-- removed. Run outside a transaction because PostgreSQL requires CONCURRENTLY.
drop index concurrently if exists public.idx_residential_sale_listings_public_locality_slug;
drop index concurrently if exists public.idx_residential_rent_listings_public_locality_slug;
drop index concurrently if exists public.idx_commercial_sale_listings_public_locality_slug;
drop index concurrently if exists public.idx_commercial_rent_listings_public_locality_slug;
drop index concurrently if exists public.idx_residential_sale_listings_locality_id;
drop index concurrently if exists public.idx_residential_rent_listings_locality_id;
drop index concurrently if exists public.idx_commercial_sale_listings_locality_id;
drop index concurrently if exists public.idx_commercial_rent_listings_locality_id;
