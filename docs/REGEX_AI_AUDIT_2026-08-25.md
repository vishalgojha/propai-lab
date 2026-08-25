# Regex / AI extraction audit — 2026-08-25

## Scope

This is a static audit of the four core extraction modules named in the data
quality review: `ai_extraction.py`, `extraction.py`,
`extraction_quality.py`, and `routers/infra.py`. It does not treat every regex
as a classifier. Many expressions are field parsers, evidence validators,
formatters, or safety filters.

An AST count found 316 calls on the `re` module (314 matching/transform calls;
the remainder are `re.escape`). The count is a maintenance signal, not a
quality score.

## Classification

| Class | Examples | Disposition |
| --- | --- | --- |
| Evidence / safety guard | building-name junk, phone redaction, source-price plausibility, title money/type cross-check | Keep. These reject or quarantine unsupported output and do not invent a replacement fact. |
| Deterministic normalization | price units, BHK/area coercion, locality spelling, date and parking parsing | Keep when the source marker is unambiguous; retain raw evidence and flags. |
| Source-authoritative correction | explicit `for sale` / `for rent`, explicit sale price, labelled rent shorthand | Keep because the product contract gives exclusive source markers priority, but record when the AI disagreed. |
| Presentation fallback | deterministic summary-title generation after an AI title fails grounding | Keep as a fallback. It must read the typed schema fields, never listing `price` for requirements. |
| Potential second-guessing | broad locality/asset inference and generic field rescue | Review case-by-case. These should not overwrite a populated AI value unless the source evidence is exclusive and the change is observable. |

## Change made

`_apply_deterministic_field_fallbacks()` and the provider normalization path now
record a `deterministic_overrides` entry and add
`source_transaction_override_ai` when an exclusive source marker changes the
provider's sale/rent route. The log includes field, old value, new value, and
reason. The fallback no longer clears an existing review state merely because
the regex found an explicit marker.

This preserves the existing documented rule: an exclusive explicit source
marker outranks a conflicting AI transaction label. It makes the disagreement
auditable instead of silently replacing the model decision.

## Remaining audit boundary

This pass does not remove broad regex coverage wholesale. Removing those
guards without corpus evidence would risk accepting fabricated inventory.
Future cleanup should measure each remaining field override against labelled
WhatsApp examples and require a source quote or validation flag for any new
override.

## Production monitoring query

Run this read-only query after deployment through the approved SQL bridge:

```sql
select date_trunc('hour', created_at) as hour,
       count(*) filter (where validation_flags ? 'source_transaction_override_ai') as ai_transaction_overrides,
       count(*) as extracted_rows
from public.residential_sale_listings
group by 1
union all
select date_trunc('hour', created_at),
       count(*) filter (where validation_flags ? 'source_transaction_override_ai'),
       count(*)
from public.residential_rent_listings
group by 1
order by 1 desc;
```

Repeat for the two commercial typed tables when investigating commercial
traffic. A rising override rate is a review signal; it is not proof that the
AI or the source guard is wrong.
