# Data Quality Rules

PropAI parses unstructured WhatsApp messages into structured property data. WhatsApp messages are noisy — brokers use abbreviations, typos, mixed languages, and inconsistent formats. These rules govern how we handle that chaos.

## Core principle

Same building ≠ same flat. A listing is identified by the combination of: building + unit (floor/wing/flat) + broker + transaction type. Two messages about the same building but different floors are two different listings.

## Extraction rules

### Building identity
- `building_name` is the canonical name from the message (e.g., "Lodha Sea View").
- `building_aliases` stores variations (e.g., "Lodha Seaview", "Lodha Sea-View").
- Building names are case-insensitive for matching but stored in original case.
- A building without a name gets `building_name: null` — never a fabricated name.

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

### Transaction type
- `transaction_type` is one of: `SALE`, `RENT`, `LEASE`, `PRE_LEASED`.
- If not explicitly stated, inferred from context (e.g., "available for" + rent keywords = RENT).

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

- Same broker + same building + same unit + same transaction type within 24 hours = dedup (keep the latest).
- Same building + different broker = two separate listings.
- Same building + same broker + different floor/wing = two separate listings.

## What we never do

- Never guess a building name from context.
- Never fill in a price from "similar" listings.
- Never merge listings from different brokers.
- Never auto-correct broker typos in stored data (we normalize for search, not for storage).
- Never show data we're not confident about without marking it as uncertain.
