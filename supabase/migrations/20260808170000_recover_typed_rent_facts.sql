-- Older typed backfills persisted native rent numbers (e.g. 4 for ₹4 Lakh)
-- and occasionally missed the building line. Recover from source-grounded
-- fields so the live view does not turn real prices into "Price on request".
do $$
declare
  table_name text;
begin
  foreach table_name in array array['residential_rent_listings', 'commercial_rent_listings'] loop
    execute format($sql$
      update %I l
         set monthly_rent = coalesce(
           case
             when l.price_raw_text ~* '([0-9]+(?:\.[0-9]+)?)\s*(?:lakh|lakhs|lac|lacs|l)\M'
               then ((regexp_match(l.price_raw_text, '([0-9]+(?:\.[0-9]+)?)\s*(?:lakh|lakhs|lac|lacs|l)\M', 'i'))[1])::numeric * 100000
             when l.price_raw_text ~* '([0-9]+(?:\.[0-9]+)?)\s*(?:crore|crores|cr)\M'
               then ((regexp_match(l.price_raw_text, '([0-9]+(?:\.[0-9]+)?)\s*(?:crore|crores|cr)\M', 'i'))[1])::numeric * 10000000
             when l.price_raw_text ~* '([0-9]+(?:\.[0-9]+)?)\s*k\M'
               then ((regexp_match(l.price_raw_text, '([0-9]+(?:\.[0-9]+)?)\s*k\M', 'i'))[1])::numeric * 1000
           end,
           nullif(l.ai_extraction #>> '{price,amount}', '')::numeric,
           l.monthly_rent
         )
       where l.monthly_rent > 0 and l.monthly_rent < 1000
    $sql$, table_name);

    execute format($sql$
      update %I l
         set building_name = btrim((regexp_match(rm.message,
           '(?is)\m\d+(?:\.\d+)?\s*(?:bhk|rk)\M[^\n]*(?:\n\s*){1,3}[*_` ]*([^*\n]+)'))[1], ' .,-')
        from raw_messages rm
       where rm.id = l.raw_message_id
         and nullif(btrim(l.building_name), '') is null
         and rm.message ~* '\m\d+(?:\.\d+)?\s*(?:bhk|rk)\M'
         and (regexp_match(rm.message,
           '(?is)\m\d+(?:\.\d+)?\s*(?:bhk|rk)\M[^\n]*(?:\n\s*){1,3}[*_` ]*([^*\n]+)'))[1] !~* '^(for|prime|location|available|rent|sale|lease|carpet|area|status|floor|parking|possession|inspection|photos?|contact|details)\b'
    $sql$, table_name);
  end loop;
end $$;
