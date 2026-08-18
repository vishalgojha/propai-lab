-- `none` means no furnishing value was supplied; it is not a bad furnishing
-- category. Remove only this exact historical false-positive flag.
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
                where value <> 'unrecognised_furnishing:none'
            )
            where exists (
                select 1
                from jsonb_array_elements_text(coalesce(row.validation_flags, '[]'::jsonb)) item(value)
                where item.value = 'unrecognised_furnishing:none'
            )
        $sql$, table_name);

        execute format($sql$
            update public.%I
            set needs_review = false
            where needs_review = true
              and coalesce(validation_flags, '[]'::jsonb) = '[]'::jsonb
        $sql$, table_name);
    end loop;
end $$;
