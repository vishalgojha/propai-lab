-- Repair rows where the provider expanded a source-capped budget into a
-- fabricated range. The raw WhatsApp message remains the evidence of record.
update public.residential_sale_requirements as r
set budget_min = null,
    budget_max = 60000000,
    ai_extraction = jsonb_set(
        jsonb_set(coalesce(r.ai_extraction, '{}'::jsonb), '{budget_min}', 'null'::jsonb),
        '{budget_max}', '60000000'::jsonb
    ),
    corrected_fields = ARRAY(
        SELECT DISTINCT field
        FROM unnest(
            coalesce(r.corrected_fields, ARRAY[]::text[])
            || ARRAY['budget_min', 'budget_max']::text[]
        ) AS field
    ),
    corrected_at = now()
from public.raw_messages as m
where r.raw_message_id = m.id
  and (
      (r.budget_min = 6000000 and r.budget_max = 6000000000)
      or (
          r.budget_min is null
          and r.budget_max = 60000000
          and r.ai_extraction->>'budget_max' = '6000000000'
      )
  )
  and m.message ilike '%Budget: Up to%'
  and m.message ilike '%6 Cr%';
