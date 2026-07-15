# WhatsApp Card Parser Spec

Status: latest agreed version
Version: 1.1
Date: 2026-07-16

This document captures the current agreed parsing model for broker WhatsApp messages. It is the latest working contract for structured WhatsApp extraction until explicitly replaced.

Representative fixtures and bucket mapping live in [WhatsApp Card Parser Corpus](./whatsapp-card-parser-corpus.md).

## Goal

Turn one WhatsApp post into one or more structured market cards.

The product should behave like structured Magicbricks cards generated from WhatsApp:

- keep raw evidence intact
- split multi-listing posts into separate cards
- attach sender signature and recall CTA to every card
- unify broker/entity identity across groups
- update latest-seen timestamps when the same broker reposts the same card later

## Layering

### 1. Raw Layer

Store the incoming WhatsApp message as immutable evidence.

Rules:
- never delete raw evidence during normal processing
- dedupe only exact repeated raw ingestion when the same `message_uid` repeats
- preserve the original payload, timestamp, group, sender, and context

### 2. Card Layer

Split the raw message into one or more structured cards.

Each card should have its own identity and should be queryable independently.

Card types:
- listing
- requirement
- mixed post with both listing and requirement cards

### 3. Broker Entity Layer

Unify the same broker across groups and across repeated reposts.

Rules:
- the same broker can live in multiple groups
- cross-group repeats are evidence for the same broker/entity, not separate broker identities
- repeated sightings should update `last_seen`
- do not overwrite raw evidence timestamps

## Schema Philosophy

The schema should be exhaustive but permissive.

Rules:
- create cards even when most fields are missing
- never block on missing building, price, floor, furnishing, possession, or availability
- keep raw text as evidence
- normalize common broker wording into canonical enums
- allow later enrichment from reposts or additional evidence
- store `null` for unknown scalar fields and empty arrays for unknown multi-value fields

## Shared Card Envelope

Every extracted card should carry:

- `card_id`
- `raw_message_id`
- `card_index`
- `card_type`
- `asset_type`
- `transaction_type`
- `property_type`
- `building_name`
- `project_name`
- `location_raw`
- `micro_market`
- `city`
- `sender_name`
- `sender_phone`
- `sender_signature`
- `wa_me_cta`
- `first_seen`
- `last_seen`
- `confidence`
- `raw_block_text`
- `normalized_text`
- `missing_fields`
- `extracted_entities`
- `highlights`

## Residential Schema

Residential should share one schema family for sale, rent, and lease.

### Core residential fields

- `configuration`
- `tower_name`
- `wing_name`
- `locality`
- `sub_locality`
- `carpet_area_sqft`
- `builtup_area_sqft`
- `super_builtup_area_sqft`
- `furnishing`
- `floor`
- `view`
- `facing`
- `parking`
- `possession_status`
- `availability_status`
- `possession_date`
- `available_from`
- `ready_by`
- `construction_stage`
- `launch_timeline`
- `expected_possession`

### Residential rent fields

- `monthly_rent`
- `deposit`
- `lock_in_period`
- `notice_period`
- `lease_term`
- `rent_negotiable`

### Residential sale fields

- `total_asking_price`
- `price_unit`
- `price_model`
- `price_per_sqft`
- `negotiable`
- `freehold_status`
- `oc_status`
- `recurring_charges`

### Residential defaults

- `maintenance` is not a core residential field
- if a recurring charge is explicitly mentioned, keep it under `recurring_charges`
- sale posts can still mention future possession and under-construction status
- rent posts can still mention `available_from`

## Commercial Schema

Commercial is a sibling schema, not a strict subtype.

### Core commercial fields

- `configuration`
- `tower_name`
- `wing_name`
- `locality`
- `sub_locality`
- `carpet_area_sqft`
- `builtup_area_sqft`
- `super_builtup_area_sqft`
- `mezzanine_area_sqft`
- `terrace_area_sqft`
- `usable_area_sqft`
- `furnishing`
- `fitout_status`
- `floor`
- `floor_range`
- `view`
- `facing`
- `parking`
- `power_backup`
- `washroom_count`
- `pantry`
- `ceiling_height`
- `entry_type`
- `availability_status`
- `possession_date`
- `available_from`
- `ready_by`
- `construction_stage`
- `expected_possession`
- `occupancy_type`
- `commercial_use_type`
- `tenant_name`

### Commercial pricing fields

- `total_asking_price`
- `price_unit`
- `price_model`
- `price_per_sqft`
- `rent_per_sqft`
- `negotiable`
- `deposit`
- `recurring_charges`
- `lock_in_period`
- `lease_term`

## Timing / Status Layer

Timing should be shared across residential and commercial.

Use these fields when the broker mentions availability or possession timing:

- `availability_status` = `available | under_construction | coming_soon | occupied | immediate | on_request`
- `construction_stage` = `under_construction | ready | new_launch | pre_launch | resale`
- `possession_date`
- `available_from`
- `ready_by`
- `launch_timeline`
- `expected_possession`

Examples:
- `Possession Aug 2028` -> `construction_stage = under_construction`, `expected_possession = Aug 2028`
- `Available from 15 Aug` -> `available_from = 15 Aug`

## Furnishing Normalization

Normalize broker wording into one canonical field.

Canonical values:
- `unfurnished`
- `semi_furnished`
- `fully_furnished`
- `plug_and_play`
- `bare_shell`
- `other`
- `unknown`

Common variants:
- `semi furnished`, `semi fur`, `sf`
- `fully furnished`, `full furnished`, `fully fur`, `ff`
- `unfurnished`, `uf`
- `plug & play`, `plug and play`
- `bare shell`

Preserve the original wording in raw text or `extracted_entities`, but emit the canonical form in `furnishing`.

## Parsing Rules

### Minimum creation threshold

Create a card if the message is confidently a real estate post and contains at least one strong signal:

- configuration
- area
- price
- building/project name
- explicit rent/sale/lease language

### Never block on missing fields

These must not prevent card creation:

- building name
- price
- area
- floor
- furnishing
- possession date
- available from
- tower / wing
- parking

### Multi-listing messages

Messages containing multiple blocks must be split into separate cards.

Use block structure, not one regex over the full message.

Typical block markers:
- headings like `2 BHK`, `Requirement 1`, `Available for lease`
- blank lines
- repeated bullet groups
- sender signature/footer lines

### Commercial inventory

Commercial posts must infer:

- `asset_type = Commercial`
- `property_type = Office` when the block describes office space
- `transaction_type = Rent` when the post is rental inventory

### Price handling

When the post says PSF or PSFT:

- store the per-sq-ft rate as the primary pricing basis
- expose a display price like `price_per_sqft`
- if area is known, compute the implied total ask separately

### Sender signature

Every card should keep the sender signature and contact details.

The signature should not replace the broker entity.

### Recall CTA

Every card should expose a WhatsApp recall/share CTA for that specific card.

The CTA should point to the canonical card identity, not just the raw post.

## Deduplication Rules

### Exact raw repeat

If the same `message_uid` arrives again:
- treat it as the same raw message
- do not create duplicate raw evidence

### Same broker, repeated card

If the same broker reposts the same listing or requirement later:
- keep the original raw evidence
- update the canonical card/entity `last_seen`
- keep the latest timestamp in the market-facing view

### Same broker across groups

If the same broker posts in multiple groups:
- collapse those posts into one broker/entity view
- keep group provenance in evidence
- do not show separate broker entities in Market Inbox

## Example Expectations

For a commercial office post like:
- Lodha Supremus
- Prabhadevi
- Office
- Rent
- 425 PSF

Expected interpretation:
- one commercial office card
- building name present
- locality present
- rate represented as PSF
- total ask computed only if area is known
- sender signature and recall CTA appended

For a multi-block inventory post:
- split every property block into its own card
- preserve shared broker signature on each card
- preserve the raw post as the evidence source

## Non-Goals

This spec does not change:
- the raw evidence model
- the broker identity spine
- the existing WhatsApp ingestion transport

It only defines the current latest card parser contract.
