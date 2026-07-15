-- Add initial residential schema fields to parsed_output

alter table parsed_output
    add column if not exists asset_type text,
    add column if not exists property_type text,
    add column if not exists transaction_type text,
    add column if not exists configuration text,
    add column if not exists price_model text,
    add column if not exists price_per_sqft numeric,
    add column if not exists monthly_rent numeric,
    add column if not exists total_asking_price numeric,
    add column if not exists furnishing_canonical text,
    add column if not exists availability_status text,
    add column if not exists possession_status text,
    add column if not exists possession_date text,
    add column if not exists available_from text,
    add column if not exists ready_by text,
    add column if not exists construction_stage text,
    add column if not exists launch_timeline text,
    add column if not exists expected_possession text;

create index if not exists idx_parsed_asset_type on parsed_output(asset_type);
create index if not exists idx_parsed_property_type on parsed_output(property_type);
create index if not exists idx_parsed_transaction_type on parsed_output(transaction_type);
