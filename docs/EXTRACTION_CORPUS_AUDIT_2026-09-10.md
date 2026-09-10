# Extraction corpus audit — 2026-09-10

## Executive conclusion

The production corpus is large enough to drive a serious extraction hardening
program. It contains **831,213 raw WhatsApp messages** and **54,605 typed
listing records** across the four current inventory tables. Every typed record
in the audit linked back to an existing `raw_messages` row, so the comparison
can remain source-grounded.

The first result is not “Sarvam is wrong 99.9% of the time.” The apparent
review rate is materially inflated by an operational backfill marker:
`grounding_backfill_20260830` appears on 50,280 rows. That marker should be
separated from model/extraction quality metrics before using the dashboard as a
quality score.

## Corpus size and persistence coverage

| Measure | Count | Interpretation |
| --- | ---: | --- |
| Raw messages | 831,213 | Full captured WhatsApp corpus |
| Raw messages marked processed | 686,371 | 82.6% of raw corpus |
| Residential rent rows | 11,039 | Typed inventory |
| Residential sale rows | 31,296 | Typed inventory |
| Commercial rent rows | 10,363 | Typed inventory |
| Commercial sale rows | 1,906 | Typed inventory |
| Typed rows | 54,605 | Current typed inventory total |
| Typed rows linked to raw evidence | 54,605 | 100% linkage |
| Raw messages producing multiple typed rows | 1,792 | Multi-listing fanout is real |
| Maximum typed rows from one raw message | 19 | Boundary handling matters |
| Typed rows from multi-row raw messages | 6,139 | 11.2% of typed rows |

The raw-to-typed ratio is expected to be below one because raw history includes
non-listing messages, requirements, operational chatter, duplicates, and rows
that are not eligible for publishing. It should not be used as an extraction
accuracy score.

## Quality signal correction

| Signal | Count | Share of typed rows | Initial reading |
| --- | ---: | ---: | --- |
| `needs_review = true` | 54,543 | 99.9% | Inflated by operational markers |
| `grounding_backfill_20260830` | 50,280 | 92.1% | Backfill/instrumentation, not model error |
| Review without that backfill marker | 4,264 | 7.8% | Better first approximation of active quality exceptions |
| Rows with no validation flags | 55 | 0.1% | Current flagging is very broad |

The dashboard should report at least three separate numbers:

1. operational/backfill-marked rows;
2. source-grounding or parser exceptions;
3. genuinely clean rows after excluding operational markers.

## Top recurring flags

Counts below are flag occurrences across typed records, not claims that every
occurrence is a unique root cause.

| Flag | Occurrences | Priority | What the sample suggests |
| --- | ---: | --- | --- |
| `title_evidence_mismatch` | 16,075 | P0 | Systemic title-grounding/validation mismatch, especially on multi-listings |
| `bhk_source_missing` | 14,026 | P0 | BHK is often absent from the selected slice or older source evidence is incomplete |
| `missing_price` | 11,513 | P0 | Mix of truly missing quotes and price text that was not normalized into a numeric field |
| `missing_building_or_locality` | 10,180 | P0 | Boundary/context resolution issue; several rows have one but not both |
| `furnishing_without_source_evidence` | 9,624 | P1 | Furnishing inference is frequently not source-backed |
| `price_source_missing` | 7,168 | P0 | Numeric price survives while an auditable source quote does not |
| `bhk_dropped_not_in_source_slice` | 3,080 | P0 | Model value is being quarantined because item-scoped evidence is incomplete |
| `locality_source_conflict` | 568 | P1 | Resolver and raw label disagree; needs boundary-aware locality handling |
| `price_value_not_traceable_to_source` | 1,399 | P0 | Numeric value cannot be proven against the selected source text |
| `price_total_source_conflict` | 75 | P0 | Direct price disagreement; small volume but financially dangerous |
| `invalid_price_unit:per_sqft` | 1,764 | P0 | Price basis/unit representation is inconsistent and can distort market data |

Some flags are informational rather than failures. For example,
`commercial_source_evidence` appears 8,476 times and should not automatically
count against extraction quality.

## Raw-vs-saved examples

### 1. Multi-listing sale broadcast: raw boundary is correct, title flag is not

Raw message `1054309` contains a `3BHK | SALE OPTIONS` broadcast with at least
nine independent building/price options. The stored rows have distinct slices,
for example:

```text
Rustomjee Crown, Prabhadevi – C Tower | 3 BHK | 1750 sqft | Bare Shell | ₹14.50 Cr | 2 Car Parks
Indiabulls Sky, Lower Parel | 3 BHK | 2477 sqft | Bare Shell | ₹10.50 Cr | 2 Car Parks
Modern Vivarea, Mahalaxmi – South | 3 BHK | 1740 sqft | Bare Shell | ₹1L/PSF | 2 Car Parks
```

The item-level values and prices are source-consistent, but each row still
receives `title_evidence_mismatch`. This indicates that the dominant problem
is likely the title validator or title construction contract, not the
item-slicing itself. It is unsafe to use this flag as a blanket extraction
failure until title evidence is checked independently from property-field
evidence.

### 2. Mixed sale/rent broadcast: sibling context is the main risk

Raw message `1053084` contains sale options, a rental section, and multiple
configurations under Rustomjee Cleon. The corpus correctly demonstrates why a
whole-message prompt is insufficient: a message-level location, transaction
type, or price can belong to a sibling item. The selected source slices are
mostly item-scoped, but rows show missing building names and title flags. The
high-value fix is boundary-first extraction plus field-level evidence checks,
not another generic instruction paragraph.

### 3. Same-building alternatives: distinguish listing identity from building
identity

Raw message `1034569` has three Lodha Trump Tower options with different
furnishing/view/price details. The building is shared, but the listings are not
duplicates. This is a useful regression family for preserving separate
`listing_index` rows while allowing the same `building_id`.

### 4. Compact shorthand is a normalization family, not a prompt family

Raw messages such as `1013662` use forms like `@200k nego`, `1250crpt`, and
`1 open parking`; other rows use `46k persqft`, `1L/PSF`, or `19Lac`. These
formats need explicit normalized representations for amount, unit, period, and
price basis. Treating them as a single total price creates the exact failures
seen in `invalid_price_unit`, low-price guards, and untraceable price flags.

## Evidence-storage finding

Only 5,479 of 54,605 typed rows currently contain a non-empty
`ai_extraction.source_slice` value. No rows used the tested `raw_payload`
source-slice keys; 32,500 have `normalized_message`. The API can reconstruct
evidence through `raw_message_id`, but the persisted extraction payload is not
uniformly self-describing. This makes replay and debugging harder and should be
treated as a storage-contract gap, not silently attributed to Sarvam.

## Recommended hardening order

### P0 — measurement and boundary correctness

- Split operational/backfill markers from extraction-quality metrics.
- Build a replay corpus keyed by `raw_message_id + listing_index`.
- Audit `title_evidence_mismatch` separately from field-value grounding.
- Make source-slice presence and exclusivity measurable for every typed row.
- Create regression fixtures for mixed sale/rent messages, repeated buildings,
  compact price shorthand, and sibling listing leakage.

### P1 — field contracts

- Normalize price as `{amount, unit, period, basis, raw_text}` without allowing
  a PSF quote to become a total price.
- Require source evidence before persisting inferred furnishing, building, BHK,
  possession, or price basis values.
- Preserve a missing value as missing; do not convert it to a plausible guess.
- Keep building identity separate from listing identity.

### P2 — operational feedback

- Replay the highest-volume broker formats after every extraction change.
- Track per-broker and per-format failure rates, not only global rates.
- Use human corrections as labelled evaluation data, while keeping the source
  message immutable.

## Audit limitations

This is a read-only production audit using aggregate SQL and a redacted sample
of raw evidence. It identifies observed recurring failures; it does not yet
re-run all 831,213 raw messages through the current pipeline. The next phase is
to build the bounded replay/evaluation harness and produce field-level precision
and recall on a stratified sample.
