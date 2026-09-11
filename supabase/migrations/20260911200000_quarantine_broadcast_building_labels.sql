-- Broadcast section headings are not physical buildings.  Older extraction
-- rows can still contain these labels because the runtime guard previously
-- covered "direct inventory" but not "direct outright opportunities".
-- Preserve the raw message and evidence; only quarantine the polluted
-- identity/title fields so the feed can regenerate a source-grounded title.
do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'residential_sale_listings',
    'residential_rent_listings',
    'commercial_sale_listings',
    'commercial_rent_listings',
    'residential_sale_requirements',
    'residential_rent_requirements',
    'commercial_sale_requirements',
    'commercial_rent_requirements'
  ] loop
    execute format($sql$
      update public.%I
      set building_name = null,
          summary_title = null,
          needs_review = true,
          extraction_confidence = 'low',
          corrected_fields = array(
            select distinct value
            from unnest(coalesce(corrected_fields, '{}'::text[]) || array['building_name']) as value
          ),
          corrected_at = now(),
          updated_at = now(),
          validation_flags = array(
            select distinct value
            from unnest(
              coalesce(validation_flags, '{}'::text[])
              || array['building_name_is_listing_text', 'building_name_unresolved']
            ) as value
          )
      where regexp_replace(lower(trim(building_name)), '\s+', ' ', 'g') in (
        'direct outright opportunities',
        'direct outright opportunity',
        'direct opportunities',
        'outright opportunities',
        'outright opportunity'
      )
    $sql$, table_name);
  end loop;
end $$;
