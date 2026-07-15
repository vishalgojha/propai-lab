-- Add commercial parser fields to parsed_output

alter table parsed_output
    add column if not exists commercial_use_type text,
    add column if not exists fitout_status text,
    add column if not exists occupancy_type text,
    add column if not exists floor_range text,
    add column if not exists rent_per_sqft numeric;

create index if not exists idx_parsed_commercial_use_type on parsed_output(commercial_use_type);
create index if not exists idx_parsed_fitout_status on parsed_output(fitout_status);
create index if not exists idx_parsed_occupancy_type on parsed_output(occupancy_type);
