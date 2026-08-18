-- Finalize removal using element-level existence checks. JSONB `?|` has
-- version-dependent behavior for arrays, so do not use it for this cleanup.
do $$
declare
    table_name text;
begin
    foreach table_name in array array[
        'residential_sale_listings', 'residential_rent_listings',
        'commercial_sale_listings', 'commercial_rent_listings',
        'residential_sale_requirements', 'residential_rent_requirements',
        'commercial_sale_requirements', 'commercial_rent_requirements'
    ] loop
        execute format($sql$
            update public.%I row
            set validation_flags = (
                select coalesce(jsonb_agg(value order by ordinal), '[]'::jsonb)
                from jsonb_array_elements_text(coalesce(row.validation_flags, '[]'::jsonb))
                     with ordinality as items(value, ordinal)
                where value not in (
                    'unrecognised_asset_type:residential',
                    'unrecognised_asset_type:commercial'
                )
            )
            where exists (
                select 1
                from jsonb_array_elements_text(coalesce(row.validation_flags, '[]'::jsonb)) item(value)
                where item.value in (
                    'unrecognised_asset_type:residential',
                    'unrecognised_asset_type:commercial'
                )
            )
        $sql$, table_name);
    end loop;
end $$;
