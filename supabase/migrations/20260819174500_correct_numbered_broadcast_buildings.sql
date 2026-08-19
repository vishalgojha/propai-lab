-- Correct the rows produced before parenthesized numbered markers were
-- recognized as block starts. The full parent message establishes the mapping:
-- (1) Honeycomb, (2) no building, (3) Sunny Side, (4) Hicon residency.
update public.residential_rent_listings
set building_name = case raw_message_id
      when 100666 then 'Honeycomb'
      when 100667 then null
      when 100668 then 'Sunny Side'
      when 100669 then 'Hicon residency'
      else building_name
    end,
    updated_at = now()
where raw_message_id in (100666, 100667, 100668, 100669);
