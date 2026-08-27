# Data Quality Rules

PropAI parses unstructured WhatsApp messages into structured property data. WhatsApp messages are noisy — brokers use abbreviations, typos, mixed languages, and inconsistent formats. These rules govern how we handle that chaos.

## Core principle

Same building ≠ same flat. A listing is identified by the combination of: building + unit (floor/wing/flat) + broker + transaction type. Two messages about the same building but different floors are two different listings.

## Intelligence and claim boundaries

Analytics and user-facing insights must be descriptive and reproducible. A
metric is valid only when its definition, units, tenant/workspace scope,
selected groups or coverage scope, time window, freshness, and source record
count are known. Use language such as “12 requirements captured in the last 7
days” or “6 captured listings mention Bandra West”; do not convert these
observations into “high demand,” “low supply,” “most active broker,” or other
market-wide claims.

Comparable trend claims require the same metric definition, comparable
coverage, and an explicit minimum sample threshold. If coverage is unknown or
too small, show the measurable observation with a limitation note or omit the
inference. LLMs may summarize computed metrics, but may not create unsupported
market conclusions.

## Extraction rules

### Building identity
- `building_name` is the canonical name from the message (e.g., "Lodha Sea View").
- `building_aliases` stores variations (e.g., "Lodha Seaview", "Lodha Sea-View").
- Building names are case-insensitive for matching but stored in original case.
- A building without a name gets `building_name: null` — never a fabricated name.
- Descriptive phrases such as "Well maintained bldg" are not building names.
  Verify that they are rejected by `extraction_quality.py:building_name_problem`
  and do not silently pass through typed persistence.

### Location hierarchy
- `micro_market` = the area/locality (e.g., "Bandra West").
- `macro_market` = the city/region (e.g., "Mumbai").
- Both are normalized from the message text + context. Raw `location_raw` is preserved as-is.

### Price handling
- Prices are stored as raw numbers with `price_unit` (e.g., `price: 15000000, price_unit: ""` for ₹1.5 Cr).
- `price_unit` values: `""` (absolute), `"lac"`, `"lakh"`, `"cr"`, `"crore"`, `"sqft"`, `"month"`, `"year"`.
- `percent_of_price` in additional charges stores the raw percent (e.g., `3` means 3%, not 0.03).
- Zero or negative prices are stored as `null` — never as 0.

### Floor / wing / flat
- `floor` is the floor number (integer or null).
- `wing` is the tower/block letter (e.g., "A", "B").
- `flat_number` is the unit identifier.
- These disambiguate units within the same building. Two listings with the same building but different floors are distinct.

### BHK
- `bhk` stores the configuration string (e.g., "2 BHK", "3.5 BHK", "1 RK").
- Numeric BHK values are normalized; fractional BHK (e.g., 2.5) is preserved.
- BHK is residential-only. Commercial listings and commercial requirements must
  never receive a BHK value; an AI suggestion to add one is an extraction error,
  not evidence to be normalized or filled in.

### Transaction type
- `transaction_type` is one of: `SALE`, `RENT`, `LEASE`, `PRE_LEASED`.
- If not explicitly stated, inferred from context (e.g., "available for" + rent keywords = RENT).
- Explicit `available sale`, `for sale`, `sale price`, `outright`, and `outrate` markers override an LLM's conflicting `RENT` result when no rent marker is present.
- Explicit `available rent`, `for rent`, `monthly rent`, and `rent -` markers similarly override a conflicting `SALE` result when no sale marker is present.
- A crore-denominated price is not a monthly rent by itself. Mixed sale-and-rent messages require item-level splitting; do not apply a whole-message override.
- Requirements preserve their transaction mode: `1 BHK on rent` is a rental requirement, not a generic purchase request. Extract explicit BHK, budget, preferred locations, tenant type, parking, and amenity requirements from the requirement body.

### Bulk WhatsApp broadcasts
- `DIRECT INVENTORIES`, `SIGNATURE SPACES`, and similar portfolio headers followed by repeated separator lines represent multiple independent supply listings.
- Each separator-delimited block is a separate extraction unit. Never send the complete broadcast to the model as one listing, and never let one block's rent/sale marker determine another block's transaction type.
- A trailing instruction such as `CLIENT PROFILE REQUIRED PRIOR TO CONFIRMING VIEWINGS` is broker workflow/footer text. It does not convert the preceding inventory broadcast into a requirement and is excluded from the extraction slice while the original raw message remains evidence.
- Broker signatures and contact details are source metadata. They may be propagated to each split item without another LLM call, but must not become building names, prices, or requirements.

### Deal tags
- Whitelist: `distress_sale`, `urgent_sale`, `negotiable`, `bank_auction`, `resale`, `exclusive_mandate`, `price_drop`.
- Only set when the message explicitly contains evidence for the tag.
- Tags are additive, not exclusive.

### Additional charges
- Shape: `{"label": str, "amount": float, "amount_type": "fixed" | "percent_of_price"}`.
- `percent_of_price` stores the raw percent (e.g., `3` not `0.03`).
- Only recorded when explicitly mentioned in the message.

## Freshness

- `last_seen` timestamp is updated every time a listing is re-mentioned in a WhatsApp message.
- Listings with no activity for 30+ days are hidden from the public site (but kept in the database).
- The sitemap uses a 90-day freshness window for listing URLs.

## Deduplication

- WhatsApp message identity is anchored to the resolved author phone JID (the
  original sender JID is retained as evidence) plus a normalized content
  fingerprint. The group, connected PropAI session, and event message ID are
  not the broker's identity.
- An exact repost from the same author—copied into another group or received on
  another day—is retained in `raw_messages` as a new observation, but it does
  not call the LLM or create another typed listing/requirement row. The
  canonical typed row's `last_seen_at` and `expires_at` are refreshed from the
  repost timestamp, and the raw row points to the earlier observation.
- The fingerprint normalizes transport-only variation such as Unicode form,
  line endings, repeated whitespace, and case. It deliberately does not strip
  prices, dates, punctuation, or other content: a material edit receives a new
  fingerprint and is sent through extraction again.
- The gate is conservative. A changed message is not automatically merged just
  because the building appears similar; same building ≠ same flat and semantic
  similarity remains candidate ranking only.
- The older structured repost classifier still handles messages that are not
  exact copy-pastes, but it is review metadata—not the correctness-critical
  exact-copy gate.
- Same building + different broker = two separate listings.
- Same building + same broker + different floor/wing = two separate listings.

## What we never do

- Never guess a building name from context.
- Never fill in a price from "similar" listings.
- Never merge listings from different brokers.
- Never auto-correct broker typos in stored data (we normalize for search, not for storage).
- Never show data we're not confident about without marking it as uncertain.
- Never present a partial or tenant-scoped feed as a complete market census.
- Never label demand, supply, broker activity, popularity, or price direction
  without a documented measurable method and sufficient comparable data.
## Extraction audit evidence

The admin extraction view must show the original WhatsApp evidence beside the
structured row. A requirement has two dimensions: its role is BUY/requirement,
while `transaction_type` says whether the requested property is for rent or
sale. Do not collapse these into a misleading BUY-only label. Budget,
preferred localities, tenant preference, parking, and amenity requirements are
evidence-bearing fields and must remain visible for review.
