# WhatsApp Card Parser Spec

Status: latest agreed version
Version: 1.0
Date: 2026-07-15

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

## Required Card Fields

Every extracted card should aim to carry:

- `card_id`
- `raw_message_id`
- `card_index`
- `card_type`
- `transaction_type` such as rent, sale, lease
- `asset_type` such as commercial, residential
- `property_type` such as office, shop, flat
- `building_name`
- `location`
- `micro_market`
- `configuration` or `bhk`
- `area`
- `price`
- `price_model` such as total price, psf, psft, budget
- `sender_name`
- `sender_phone`
- `sender_signature`
- `wa_me_cta`
- `first_seen`
- `last_seen`
- `confidence`

## Parsing Rules

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
- expose a display price like `price_psf`
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
