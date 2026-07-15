# WhatsApp Card Parser Corpus

Status: working corpus
Source of truth: `/home/vishal/Downloads/wadata/*.zip`
Updated: 2026-07-16

This file maps the current WhatsApp export corpus into parser fixture buckets.
Use the zip archives as the canonical source, not the loose `.txt` copies.

## Corpus Goals

The corpus should cover:

- single listing cards
- mixed requirement + listing posts
- requirement-only posts
- commercial office inventory
- commercial requirement posts
- multi-listing inventory posts
- sender-signature-heavy broker formats
- noisy broadcast / meta groups
- repeated broker posts across multiple groups

## Primary Buckets

### 1. Basic Single Listing

Use for:
- simple one-card extraction
- sender signature capture
- recall CTA attachment
- basic rent/sale parsing

Recommended zips:
- `WhatsApp Chat with Bandra Broker Group(1).zip`
- `WhatsApp Chat with Mumbai Real Estate Brokers.zip`
- `WhatsApp Chat with Bandra to Juhu - 8 😃🤝.zip`

### 2. Mixed Requirement + Listing

Use for:
- splitting requirement and inventory blocks in the same post
- keeping both under the same broker entity
- requirement classification

Recommended zips:
- `WhatsApp Chat with PB - BANDRA, KHAR & SANTACRUZ (WEST) AGENTS.zip`
- `WhatsApp Chat with Andheri West Realty Network-5.zip`

### 3. Requirement Only

Use for:
- requirement-only classification
- budget / location corridor / inspection time parsing
- multiple requirements in one message

Recommended zips:
- `WhatsApp Chat with ONLY REQUIREMENT _ HOMEPIKR.zip`
- `WhatsApp Chat with Dhanki Realty - Group 2.zip`

### 4. Commercial Office Inventory

Use for:
- building name inference
- commercial / office inference
- PSF and total-price handling
- amenities, parking, deposit, lock-in, and furnishing extraction

Recommended zips:
- `WhatsApp Chat with South Mumbai commercial only.zip`
- `WhatsApp Chat with Propi SOBO Commercial.zip`
- `WhatsApp Chat with PropAI One.zip`

### 5. Commercial Requirement Posts

Use for:
- godown/shop/lease request parsing
- floor constraints
- area range and budget range
- inspection/contact lines

Recommended zips:
- `WhatsApp Chat with Dhanki Realty - Group 2.zip`

### 6. Multi-Listing Inventory

Use for:
- splitting one message into multiple structured cards
- inherited sender signature on every card
- commercial office rows with repeated building name
- repeated options in the same post

Recommended zips:
- `WhatsApp Chat with Propi SOBO Commercial.zip`
- `WhatsApp Chat with South Mumbai commercial only.zip`
- `WhatsApp Chat with Barudgar Properties 🤝.zip`

### 7. Broker Signature Heavy / Cross-Group Evidence

Use for:
- same broker posting the same or similar card in multiple groups
- entity dedupe by broker identity
- last_seen updates on repeated posts

Recommended zips:
- `WhatsApp Chat with Barudgar Properties 🤝.zip`
- `WhatsApp Chat with Bandra Broker Group(1).zip`
- `WhatsApp Chat with PB - BANDRA, KHAR & SANTACRUZ (WEST) AGENTS.zip`

### 8. Broadcast / Noise

Use for:
- non-card group events
- message noise handling
- keeping parser from inventing cards from chatter

Recommended zips:
- `WhatsApp Chat with Broadcast 2.zip`

## Suggested First Test Coverage

The first parser fixture batch should cover these exact behaviors:

1. Split a multi-listing office post into separate cards.
2. Infer `Commercial` + `Office` from office inventory.
3. Preserve building name, locality, floor, furnishing, parking, deposit, and lock-in.
4. Represent PSF pricing correctly and compute total ask only when area exists.
5. Split requirement-only posts into separate requirement cards.
6. Keep sender signature + phone + recall CTA on every card.
7. Collapse repeated broker sightings into one canonical broker entity while retaining raw evidence.
8. Reject noise / broadcast lines as cards.

## Notes

- The loose `.txt` files in the folder are older exports or mirrors.
- The `.zip` archives are the preferred source because they contain the newer data.
- If a zip has multiple internal files, prefer the chat export text and ignore unrelated sidecar files unless they are contact artifacts useful for identity matching.

