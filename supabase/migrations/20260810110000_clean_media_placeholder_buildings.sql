-- Media-only messages have no text from which a building can be inferred.
-- Keep the evidence in raw_payload, but never expose transport placeholders as
-- structured building names.
do $$
declare
    table_name text;
begin
    foreach table_name in array array[
        'residential_sale_listings',
        'residential_rent_listings',
        'commercial_sale_listings',
        'commercial_rent_listings'
    ] loop
        execute format(
            'update public.%I set building_name = null, updated_at = now() where lower(trim(building_name)) in (''[document]'', ''[image]'', ''[video]'', ''[voice message]'', ''[sticker]'')',
            table_name
        );
    end loop;
end $$;
