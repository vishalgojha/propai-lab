-- Propagate the residential/commercial split from parsed_output into the
-- listings table that www reads. parsed_output already stores asset_type,
-- property_type and commercial detail; listings dropped them in the bridge.
alter table listings
    add column if not exists asset_type text,
    add column if not exists property_type text,
    add column if not exists transaction_type text,
    add column if not exists commercial_use_type text,
    add column if not exists fitout_status text,
    add column if not exists occupancy_type text;

create index if not exists idx_listings_asset_type on listings(asset_type);
create index if not exists idx_listings_property_type on listings(property_type);
