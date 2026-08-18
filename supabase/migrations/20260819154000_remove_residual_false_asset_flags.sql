-- Correct the JSON-array cleanup for any rows whose validation_flags also
-- contain legitimate review reasons. Preserve every non-asset-type flag.
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
            set validation_flags = cleaned.flags
            from (
                select id, coalesce(
                    jsonb_agg(value order by ordinal), '[]'::jsonb
                ) as flags
                from public.%I,
                     jsonb_array_elements_text(coalesce(validation_flags, '[]'::jsonb))
                     with ordinality as items(value, ordinal)
                where value not in (
                    'unrecognised_asset_type:residential',
                    'unrecognised_asset_type:commercial'
                )
                group by id
            ) cleaned
            where row.id = cleaned.id
              and row.validation_flags ?| array[
                  'unrecognised_asset_type:residential',
                  'unrecognised_asset_type:commercial'
              ]
        $sql$, table_name, table_name);
    end loop;
end $$;
