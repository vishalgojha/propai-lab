-- Recover high-signal facts present in the source listing slice but omitted by
-- older extraction passes. The source message itself remains private.
do $$
declare
  table_name text;
begin
  foreach table_name in array array['residential_sale_listings', 'residential_rent_listings'] loop
    execute format($sql$
      update %I l
         set bhk = m.bhk::numeric
        from (
          select l2.id,
                 nullif((regexp_match(rm.message, '\m(\d+(?:\.\d+)?)\s*bhk\M', 'i'))[1], '') as bhk
            from %I l2
            join raw_messages rm on rm.id = l2.raw_message_id
           where nullif(btrim(l2.bhk::text), '') is null
             and rm.message ~* '\m\d+(?:\.\d+)?\s*bhk\M'
        ) m
       where l.id = m.id and m.bhk is not null
    $sql$, table_name, table_name);
  end loop;

  foreach table_name in array array[
    'residential_sale_listings', 'residential_rent_listings',
    'commercial_sale_listings', 'commercial_rent_listings'
  ] loop
    -- Common format: Building Name - "Deepak Silverline",\nMehboob Studio,\nBandra West.
    -- The middle line is a nearby landmark, not a second building.
    execute format($sql$
      update %I l
         set landmark_name = btrim((regexp_match(rm.message,
           '(?is)building\s+name\s*[-:]?\s*[*" ]*[^\n,]+[*" ]*,\s*\n\s*([A-Za-z][A-Za-z .&''-]{2,50})\s*,\s*\n'))[1])
        from raw_messages rm
       where rm.id = l.raw_message_id
         and nullif(btrim(l.landmark_name), '') is null
         and rm.message ~* 'building\s+name\s*[-:]'
         and (regexp_match(rm.message,
           '(?is)building\s+name\s*[-:]?\s*[*" ]*[^\n,]+[*" ]*,\s*\n\s*([A-Za-z][A-Za-z .&''-]{2,50})\s*,\s*\n'))[1] is not null
         and (regexp_match(rm.message,
           '(?is)building\s+name\s*[-:]?\s*[*" ]*[^\n,]+[*" ]*,\s*\n\s*([A-Za-z][A-Za-z .&''-]{2,50})\s*,\s*\n'))[1] !~* '^(rent|sale|available|furnished|residential|commercial|open|pets|possession|video|brokerage|kindly|call|contact)$'
         and (regexp_match(rm.message,
           '(?is)building\s+name\s*[-:]?\s*[*" ]*[^\n,]+[*" ]*,\s*\n\s*([A-Za-z][A-Za-z .&''-]{2,50})\s*,\s*\n'))[1] !~ '\d{5,}|\m(?:bhk|parking|lakh|lakhs|crore|cr|sq\.?\s*ft)\M'
    $sql$, table_name);
  end loop;
end $$;

comment on column residential_sale_listings.landmark_name is
  'Typed nearby landmark recovered from source listing context; never store the full source message here.';
