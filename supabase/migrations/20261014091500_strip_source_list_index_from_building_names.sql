-- Strip a leaked source list index from building identity and derived titles.
--
-- Jammed numbered broadcasts ("...PSF++2) Bldg...") and emphasised lists
-- ("*4.* Grotto") made the extractor carry the source list marker into the
-- building name ("1) Sugee Marina Bay Bldg") and the generated title ("...for
-- sale in 1) Sugee Marina Bay Bldg"). extraction.py now strips it on write;
-- this backfills the rows produced before that fix.
--
-- Only the unambiguous parenthesised / emphasis-wrapped index is removed. A
-- bare leading number ("1 Altamount Road") is identity and is left untouched.
-- Review the affected rows before applying:
--   select id, building_name, summary_title from residential_sale_listings
--    where building_name ~ '^[0-9]+[).]' or summary_title ~ '[0-9]+[).] ';

do $$
declare
    tbl text;
    tables text[] := array[
        'residential_sale_listings',
        'residential_rent_listings',
        'residential_sale_requirements',
        'residential_rent_requirements',
        'commercial_sale_listings',
        'commercial_rent_listings',
        'commercial_sale_requirements',
        'commercial_rent_requirements'
    ];
    lead_index text :=
        '^\s*(?:[*_~]\s*)*(?:\(\s*[0-9]{1,3}\s*\)|[0-9]{1,3}\s*\))[*_~:.\- ]*'
        '|^\s*[*_~]\s*[0-9]{1,3}\s*\.?\s*[*_~]\s*';
begin
    foreach tbl in array tables loop
        execute format(
            'update %I set building_name = regexp_replace(building_name, %L, '''') '
            'where building_name ~ %L',
            tbl, lead_index, lead_index
        );
        execute format(
            'update %I '
            'set summary_title = regexp_replace('
            'summary_title, %L, '' \1 '', ''g'') '
            'where summary_title ~ %L',
            tbl, ' (in|at) [0-9]{1,3}\) ', ' (in|at) [0-9]{1,3}\) '
        );
        execute format(
            'update %I set summary_title = regexp_replace(summary_title, %L, '''') '
            'where summary_title ~ %L',
            tbl, '^\s*[0-9]{1,3}\)\s*', '^\s*[0-9]{1,3}\)\s*'
        );
    end loop;
end $$;
