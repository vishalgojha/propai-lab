-- Fix cross-wired building names left by the block-fallback slice
-- misalignment: a row's stored building_name is another item's building
-- (grounded in a sibling row's source_slice) while the row's own model
-- ai_extraction.building_name is grounded in its own source_slice.
--
-- The condition is intentionally conservative. A row is rewritten only when
-- ALL of these hold (all comparisons are alphanumeric-normalized + lower):
--   1. the stored building_name is non-empty, and
--   2. the stored building_name is NOT present in the row's own
--      ai_extraction.source_slice, and
--   3. the model's ai_extraction.building_name IS present in the row's own
--      ai_extraction.source_slice, and
--   4. the stored building_name IS present in a DIFFERENT row's
--      ai_extraction.source_slice from the same raw_message_id.
--
-- This deliberately does NOT touch rows whose stored name merely differs from
-- the model's spelling/canonical form (e.g. "Suraj Ashiana" vs
-- "Suraj Ashiyana"), which a naive name-diff backfill would have reverted.
-- Verified pre-apply to affect 11 rows across raw messages 1725933, 1772256,
-- 1804183, 1821428, 1822848, 1827313.

DO $$
DECLARE
  tbl text;
  n integer;
  total integer := 0;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'residential_sale_listings',
    'residential_rent_listings',
    'residential_sale_requirements',
    'residential_rent_requirements',
    'commercial_sale_listings',
    'commercial_rent_listings',
    'commercial_sale_requirements',
    'commercial_rent_requirements'
  ]
  LOOP
    EXECUTE format($f$
      WITH upd AS (
        UPDATE %I t
        SET building_name = t.ai_extraction->>'building_name'
        WHERE coalesce(regexp_replace(t.building_name, '[^a-zA-Z0-9]', '', 'g'), '') <> ''
          AND coalesce(t.ai_extraction->>'building_name', '') <> ''
          AND position(
                regexp_replace(lower(t.building_name), '[^a-z0-9]', '', 'g')
                in regexp_replace(lower(coalesce(t.ai_extraction->>'source_slice', '')), '[^a-z0-9]', '', 'g')
              ) = 0
          AND position(
                regexp_replace(lower(t.ai_extraction->>'building_name'), '[^a-z0-9]', '', 'g')
                in regexp_replace(lower(coalesce(t.ai_extraction->>'source_slice', '')), '[^a-z0-9]', '', 'g')
              ) > 0
          AND EXISTS (
                SELECT 1 FROM %I s
                WHERE s.raw_message_id = t.raw_message_id
                  AND s.id <> t.id
                  AND position(
                        regexp_replace(lower(t.building_name), '[^a-z0-9]', '', 'g')
                        in regexp_replace(lower(coalesce(s.ai_extraction->>'source_slice', '')), '[^a-z0-9]', '', 'g')
                      ) > 0
              )
        RETURNING 1
      )
      SELECT count(*) FROM upd
    $f$, tbl, tbl) INTO n;
    IF n > 0 THEN
      RAISE NOTICE 'cross-wired building names fixed in %: %', tbl, n;
    END IF;
    total := total + n;
  END LOOP;
  RAISE NOTICE 'total cross-wired building names fixed: %', total;
END $$;
