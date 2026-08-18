-- `residential` and `commercial` are valid top-level asset classes used by
-- the typed tables. Older validation incorrectly marked them as unknown.
-- Remove only those two exact false flags; preserve all other review evidence.
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
            update public.%I
            set validation_flags = to_jsonb(array_remove(array_remove(
                array(select jsonb_array_elements_text(coalesce(validation_flags, '[]'::jsonb))),
                'unrecognised_asset_type:residential'
            ), 'unrecognised_asset_type:commercial'))
            where validation_flags ?| array[
                'unrecognised_asset_type:residential',
                'unrecognised_asset_type:commercial'
            ]
        $sql$, table_name);

        execute format($sql$
            update public.%I
            set needs_review = false
            where coalesce(validation_flags, '[]'::jsonb) = '[]'::jsonb
              and needs_review = true
        $sql$, table_name);
    end loop;
end $$;
