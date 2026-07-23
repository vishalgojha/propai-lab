ALTER TABLE parsed_output
  ADD COLUMN IF NOT EXISTS floor_range text,
  ADD COLUMN IF NOT EXISTS commercial_use_type text,
  ADD COLUMN IF NOT EXISTS fitout_status text,
  ADD COLUMN IF NOT EXISTS occupancy_type text,
  ADD COLUMN IF NOT EXISTS rent_per_sqft numeric;
