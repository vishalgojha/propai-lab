# Market Inbox opportunity-boundary rules

Market Inbox converts broker-group posts into actionable opportunities. Its
unit of truth is not a WhatsApp message or a visual paragraph: it is one
independently actionable property listing or requirement.

## Split into separate records

- Separate buildings, projects, units, flats, floors, configurations, areas,
  or prices are separate records when a broker can act on each independently.
- Two available floors or units in the same building are two records even when
  every other attribute is shared.
- Mixed listing and requirement blocks are always separated.
- A numbered or labelled option is a separate record when it has its own
  property anchor.

## Keep as one record

- A min/max budget, area, or price range describing one requirement remains
  one record.
- Alternative acceptable localities (for example, Bandra East or BKC) remain
  one requirement unless the message explicitly describes different clients.
- A floor range describing one contiguous property remains one record.

## Shared inheritance

A child record may inherit only information stated as document-wide context:

- project/building, tower or wing;
- locality and transaction intent;
- BHK, area, and furnishing when they appear before all option boundaries;
- broker/contact signature.

Tower, wing, floor, and unit identifiers are never stored as locality.

## No sibling leakage

The following option-specific values never flow from one child into another:

- floor or unit;
- BHK/configuration;
- carpet/built-up area;
- price;
- furnishing;
- availability or restrictions.

Each saved record retains isolated evidence: shared header + its own option +
shared signature. A sibling option must not appear in that evidence.

## AI validation and fallback

- AI may enrich and normalize records, but deterministic boundaries decide how
  many opportunities exist.
- AI output is accepted only when its count and explicit anchors align with the
  detected boundaries.
- Count mismatch or conflicting BHK/area/price/building triggers independent
  per-boundary extraction.
- If AI still fails, deterministic records are retained without inventing
  missing values. Ambiguous intent stays unknown.

## Deduplication

Duplicates require strong matching anchors. Different explicit floors or unit
identifiers must never collapse into one listing even when project, price, and
broker are identical.
