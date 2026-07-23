# Domain Glossary

Terms specific to PropAI and Indian real estate tech.

## Core concepts

**Listing** — A property advertisement extracted from a WhatsApp message. Contains: building, price, configuration (BHK), transaction type (sale/rent), broker, and source message.

**Requirement** — A buyer's or tenant's need, expressed as: locality preference, budget range, configuration, and transaction type. Captured from WhatsApp conversations.

**Inventory** — The set of active listings in the system. "Inventory" specifically means properties available through our broker network — not all properties in an area.

**Pocket listing** — A listing that exists only in a specific broker's knowledge, not publicly advertised. In PropAI, these surface when the broker mentions them in a WhatsApp group.

**Hot listing** — A listing with high engagement or freshness signals. Not a formal status — used internally to prioritize display.

## Data terms

**Freshness** — How recently a listing was mentioned in a WhatsApp message. `last_seen` timestamp tracks this. Listings older than 30 days are hidden; older than 90 days are excluded from the sitemap.

**Alias** — An alternative name for a building. E.g., "Lodha Sea View" and "Lodha Seaview" are aliases of the same building. Stored in `building_aliases`.

**Micro-market** — A specific locality/area within a city. E.g., "Bandra West", "Andheri East", "Powai". This is the primary geographic unit in PropAI.

**Macro-market** — The city or region. E.g., "Mumbai", "Thane".

**Building graph** — The relationship between buildings, their aliases, localities, and the brokers active in each. Used for search deduplication and locality-level aggregation.

**Parsed observation** — A structured extraction from a raw WhatsApp message. Contains: property details, broker info, confidence scores, and the source message reference.

**Raw message** — An unmodified WhatsApp message captured by the ingestor. Stored as-is with metadata (sender, group, timestamp). Never deleted.

## Transaction types

**Sale** — Property being sold. Owner/broker is the seller.

**Rent** — Property being rented out. Owner/broker is the landlord.

**Lease** — Commercial property lease (longer term than rent).

**Pre-leased** — A property that was leased before being sold. Buyer inherits the existing lease.

## Price terms

**Lakh (L)** — 100,000 INR. E.g., ₹50 L = ₹5,000,000.

**Crore (Cr)** — 10,000,000 INR. E.g., ₹1.5 Cr = ₹15,000,000.

**Per sqft** — Price per square foot. Common for commercial properties.

**Asking price** — The price the broker/owner is asking. May be negotiable.

**Deal price** — The final transaction price (rarely available at listing time).

## System terms

**WhatsMeow** — Go library for WhatsApp Web multi-device protocol. Used by the ingestor to connect to WhatsApp and receive messages.

**Ingestor** — The service that connects to WhatsApp via WhatsMeow, receives messages, and forwards them to the API.

**Extractor** — The AI pipeline that parses raw WhatsApp messages into structured listings. Uses LLM + deterministic rules.

**Confidence score** — A 0-1 score indicating how certain the extractor is about a parsed field. Low-confidence fields are flagged for review.

**Tenant** — An organization/workspace in PropAI. Each tenant has their own broker network, listings, and chat history. Data is isolated between tenants.

**Micro-tenancy** — The pattern where a single PropAI deployment serves multiple organizations, with data isolation at the row level (tenant_id column).

## WhatsApp terms

**Group** — A WhatsApp group where brokers share listings. PropAI captures messages from these groups.

**JID** — WhatsApp JID (Jabber ID). Unique identifier for a WhatsApp user or group. Format: `phone@s.whatsapp.net` for users, `id@g.us` for groups.

**Broadcast** — A WhatsApp broadcast list. Messages sent to multiple recipients individually.

**Status** — WhatsApp status/stories. Not currently captured by PropAI.
