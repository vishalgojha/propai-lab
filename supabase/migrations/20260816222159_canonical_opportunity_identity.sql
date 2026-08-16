-- Persist deterministic opportunity identity separately from the source
-- message fingerprint. Reposts create new evidence rows, but carry the same
-- opportunity key so every feed can converge on one identity.
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
        execute format(
            'alter table public.%I add column if not exists opportunity_key text',
            table_name
        );
        execute format(
            'create index if not exists %I on public.%I (opportunity_key, last_seen_at desc)',
            table_name || '_opportunity_key_idx', table_name
        );
    end loop;
end $$;
