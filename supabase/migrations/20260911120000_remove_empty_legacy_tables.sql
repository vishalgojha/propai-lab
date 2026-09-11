-- Remove empty tables from the pre-typed extraction/evidence model.
--
-- Verified against production on 2026-09-11:
--   learning_cards              0 rows
--   listing_observations        0 rows
--   observation_batches         0 rows
--   alias_suggestions           0 rows
--   combined_locality_rules     0 rows
--
-- These tables have no current application call-sites or user-defined
-- dependents. Do not add observations or observation_evidence here: the former
-- still contains 3,494 rows and the latter is referenced by the admin audit
-- metrics path.
begin;

drop table if exists public.learning_cards;
drop table if exists public.listing_observations;
drop table if exists public.observation_batches;
drop table if exists public.alias_suggestions;
drop table if exists public.combined_locality_rules;

commit;
