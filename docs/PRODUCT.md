# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are property seekers and real-estate brokers operating through
WhatsApp in India. Property seekers need to find a fresh, relevant property
and contact its broker quickly. Brokers need their live inventory and qualified
requirements organized without losing the direct relationship with the lead.

Internal workspace users also review captured messages, extraction evidence,
requirements, listings, broker identities, and matches.

## Product Purpose

PropAI connects property seekers with real brokers through WhatsApp — the
channel where Indian real estate actually operates. It captures broker-group
messages, structures the property information, and makes the resulting live
signal searchable and matchable.

Success means a property seeker finds a fresh, relevant listing and contacts
the broker directly on WhatsApp within five minutes of opening PropAI. A
secondary outcome is that brokers receive qualified enquiries rather than
portal-style spam and close deals faster than through portal leads.

## Positioning

PropAI is a WhatsApp-first discovery and matching layer for real broker
inventory. Its differentiator is the live broker-group signal and the ability
to preserve source evidence and connect the seeker directly to the broker.

PropAI is not a public property portal, chatbot, or web-scraped data
aggregator. The internal workspace now includes a bounded Private CRM utility
for a broker's own inventory; that inventory is private by default, is not
market evidence, and is never published or matched automatically.

## Operating Context

Indian real estate inventory moves through forwarded WhatsApp messages, voice
notes, screenshots, and inconsistent broker broadcasts. Listings can become
stale within hours, and the same broadcast may be reposted across groups.

WhatsApp is the source of truth: a listing or requirement enters PropAI only
when it can be traced to a real WhatsApp message from a broker. Internal users
work in a multi-tenant dashboard; public discovery pages expose source-safe
property information, while broker contact details are resolved only after a
user-initiated contact action.

## Current Product Surface

PropAI currently has two connected surfaces:

| Surface | Job | Truth boundary |
| --- | --- | --- |
| `www.propai.live` | Public discovery, locality/building pages, natural search, and direct broker contact | Only fresh, source-safe inventory is public |
| `app.propai.live` | Workspace operations: WhatsApp connections, Market Inbox, Private CRM, My Deals, Auto Matched, broker controls, campaigns, and platform administration | Tenant-scoped records, evidence, controls, and review state |

Super Admin also includes a server-side database control layer for the primary
administrator. It provides authenticated CRUD over the live public data
catalog while keeping credentials and contact fields out of rendered HTML;
schema changes remain version-controlled migrations.

The internal workspace is not a second inventory source. It is the operating
layer over captured evidence. My Deals can organize or correct structured
fields, but the original message remains attached and auditable. Auto Matched
compares open requirements with active listings; it is not an automatic deal
closer or a guarantee that a match is correct.

Private CRM is a separate tenant-owned workspace for broker-owned inventory.
Chat is the primary intake: a broker can paste or speak a property into the
workspace copilot, which prepares a draft and asks for explicit confirmation
before calling `save_private_inventory`. CSV import remains the bulk fallback;
there is no form-first requirement. Private CRM is intentionally excluded from
Market Inbox, public discovery, semantic search, and Auto Matched. A record
can enter the shared market only through a separate, explicit publish/share
action; an ordinary “save this” instruction never makes private inventory
public.

The workspace copilot is a compact floating helper for navigation and WhatsApp
status questions. Brokers can close its panel or hide it entirely, then restore
it from the small floating launcher when they want help again. The super-admin
operations agent can also receive user-selected images for a bounded visual
inspection; attachments are sent only with that request and are not inventory
evidence by themselves.

## Product Data Lifecycle

Every market record follows this evidence-preserving lifecycle:

1. **Ingest** — WhatsApp messages arrive through the isolated WhatsMeow
   connection and are retained as raw evidence with tenant, group, sender, and
   time context.
2. **Extract** — the extraction pipeline splits independent broadcast blocks,
   classifies supply versus demand, routes to the correct typed table, and
   stores structured facts plus the extraction payload and source reference.
3. **Enrich** — deterministic rules and bounded workers normalize locality,
   building, broker identity, freshness, and quality metadata from available
   evidence. Enrichment may improve a label; it may not invent a fact.
4. **Search** — structured filters provide exact market, transaction, budget,
   BHK, area, and status filtering. Semantic retrieval can improve recall or
   rank candidates, but cannot create, merge, or authorize inventory.
5. **Match** — the matcher scores compatible tenant-scoped requirements and
   listings and writes explainable match facts. A match is a suggestion for
   broker review, not a promise or an automatic merge.

The typed tables are write destinations. `listings_unified` and
`requirements_unified` are live read models over them, so a newly saved typed
record is visible to queries without a refresh or materialization step.

### What each stage guarantees

These stages are intentionally decoupled, so “ingested” does not mean
“searchable” or “enriched”:

| Stage | Success means | If it is delayed or disabled |
| --- | --- | --- |
| Ingestion | The raw WhatsApp evidence is stored with source context | Nothing downstream can safely process that message |
| Extraction | A grounded typed listing or requirement was persisted, or the message was explicitly rejected/skipped | The raw message remains auditable; no inventory is fabricated |
| Enrichment | Deterministic locality/building/broker/freshness metadata was added or updated | The typed record remains usable with its current evidence and review state |
| Semantic indexing | A privacy-clean search vector was stored for an eligible entity | Exact structured search still works; semantic search may be incomplete |
| Matching | Explainable requirement/listing suggestions were upserted within the tenant boundary | No match is shown until a later save-trigger or poll run succeeds |

Extraction and building enrichment are production workers. Semantic indexing
is an optional worker controlled by deployment configuration; its status must
be reported as running, degraded, or stopped rather than inferred from the
presence of a deployment. Worker health is operational evidence, not proof
that every row has completed that stage.

## Intelligence claims

PropAI reports observed evidence, not an automatic census of the market. Every
market-facing metric must state its scope, time window, coverage, source
record count, and last-updated time. Counts and distributions may be shown
when they are computed from the selected dataset; labels such as “high
demand,” “low supply,” “most active broker,” “best locality,” or “prices are
rising” are prohibited unless a documented method has comparable coverage and
sufficient sample size to support the claim.

LLM summaries may explain computed facts and suggest measurable next
questions, but they must not turn limited captured data into a market-wide
conclusion. Say “12 requirements captured in the last 7 days” rather than
“demand is high,” and identify when the view is workspace-scoped or covers
only selected connected groups.

## Workspace, Network, and Privacy Boundaries

- `tenant_id` is the primary workspace boundary. Ordinary workspace users see
  and modify only their active organization’s records.
- The PropAI shared network can contribute source-grounded market inventory to
  a workspace when that organization’s sharing settings permit it. Shared
  inventory is still evidence-backed and is never presented as the workspace’s
  own WhatsApp capture.
- A connected WhatsApp account controls which groups are eligible for
  extraction. Unselected, opted-out, paused, or stopped groups retain their
  raw evidence but do not silently become extraction input.
- Broker blocking is a workspace-scoped visibility control. Blocking hides a
  broker from that workspace’s market feed; it does not delete evidence or
  alter another tenant’s view.
- Platform administration is separate from workspace administration. Broker
  directory, platform WABA controls, pipeline health, and cross-tenant
  operational views require a verified Super Admin role.
- Phone numbers are never public HTML. Contact actions resolve broker contact
  details server-side after an intentional user action.

## Freshness and Processing Modes

Freshness is a product behavior, not only a database field. New WhatsApp
traffic should move through ingestion and extraction promptly, while stale
records leave public discovery after the documented freshness window.

The processing queue can be operated in two deliberate modes:

- **Live mode** prioritizes recent messages and leaves older queued evidence
  untouched. This is the normal broker-facing mode when freshness matters more
  than historical coverage.
- **Replay mode** processes older evidence only through a bounded, reviewed
  operation or an explicitly scoped worker run. It is never an implicit result
  of opening the dashboard and must not bypass group consent, tenant scope, or
  cost controls.

The UI must distinguish “no current records” from “records are still being
processed” and “records are outside the current processing scope.” It must not
turn a paused or intentionally deferred queue into a fake zero or a misleading
healthy counter.

## Capabilities and Constraints

- Capture WhatsApp broker-group activity through the isolated WhatsMeow
  ingestor and preserve raw messages as evidence.
- Deterministically extract supply listings and demand requirements into typed
  tables, with unified read models for cross-type reporting and matching.
- Search and match active listings and requirements using structured facts;
  semantic retrieval may rank candidates but does not create inventory,
  auto-merge identities, or overwrite canonical fields.
- Keep extraction, enrichment, semantic indexing, and matching as separate
  stages with observable status and retry boundaries. A failure in one stage
  must not fabricate a successful record in another stage.
- Preserve broker identity by normalized phone and canonical broker record;
  push names and source signatures are aliases or evidence, not automatic
  canonical truth.
- Keep same-building/different-unit opportunities, different brokers, and
  sale/rent opportunities separate. Never auto-merge a listing merely because
  the building appears similar.
- Hide listings with no activity for 30 or more days from public discovery;
  retain the underlying evidence for audit and internal review.
- Never expose phone numbers in public HTML. Contact resolution happens
  server-side through the broker contact action.
- Never fabricate inventory, counters, prices, building names, freshness, or
  source evidence. Uncertain extraction remains marked for review.
- Preserve the distinction between raw mention, normalized value, and inferred
  context. For example, a source may say “Bandra - Pali Naka” while the
  normalized market is “Bandra West”; both the source and the normalization
  decision remain inspectable.
- The current product depends on WhatsMeow, Supabase, FastAPI, and Next.js
  App Router. WhatsMeow is unofficial and may require replacement if
  WhatsApp changes its protocol.

## Brand Commitments

The product name is PropAI. Product language should be clear, direct, and
evidence-led. The brand must communicate a trustworthy broker operating layer,
not an opaque AI oracle or a conventional property portal.

## Evidence on Hand

- Product principles and non-negotiables: `docs/PRODUCT.md`.
- Extraction, freshness, deduplication, identity, and evidence rules:
  `docs/DATA_QUALITY.md`.
- Public crawlability and source/contact rules: `docs/SEO.md`.
- Internal and public interaction rules: `docs/UX.md`.
- Technical rationale and typed extraction architecture:
  `docs/ARCHITECTURE.md`.
- Current identity and data-quality audit with known open repair areas:
  `docs/PROPai_DATA_QUALITY_AUDIT_2026-08-16.md`.
- Live WhatsApp messages and extracted records are the product’s source
  evidence. PropAI must not invent testimonials, benchmarks, listing photos,
  or other proof assets that are not supplied by the product or its data.

## Product Principles

1. **Never fabricate inventory.** Every listing traces to a real WhatsApp
   message from a real broker.
2. **Freshness beats quantity.** A recent, relevant opportunity is more useful
   than a larger but stale inventory count.
3. **The broker owns the relationship.** Enquiries go directly to the broker
   on WhatsApp; PropAI is a discovery layer, not a middleman.
4. **Evidence over black-box certainty.** Parsed records retain their source
   message, confidence signals, and review path.
5. **Identity must be conservative.** Same building is not the same flat;
   deterministic evidence decides identity, while similarity only assists
   discovery and ranking.

6. **Stages must be honest.** Ingestion, extraction, enrichment, semantic
   indexing, and matching have different guarantees. The product must expose
   the actual stage or review state instead of collapsing all failures into a
   generic “AI result.”

7. **Consent and tenancy are product behavior.** A technically available
   WhatsApp message is not automatically eligible for every workspace or every
   processing job.

8. **Human control beats silent automation.** Editing, blocking, opting out,
   replaying, and contacting are explicit user actions with reversible or
   auditable outcomes wherever possible.

9. **Measured claims over market theatre.** PropAI describes captured evidence
   and measurable comparisons; it never presents a partial feed as the whole
   market.

## Current Non-Goals and Known Limits

- PropAI does not guarantee that every WhatsApp message becomes a listing;
  many are requirements, chatter, duplicates, signatures, or insufficiently
  grounded content.
- Semantic similarity is not a correctness-critical deduplication mechanism
  and is not a substitute for source boundaries or deterministic identity
  rules.
- Enrichment and semantic indexing are asynchronous and can lag extraction;
  a typed record must remain usable and visibly distinguishable while those
  stages are pending or under review.
- Historical raw evidence is retained for audit and controlled replay; the
  product does not promise that every historical message is always processed.
- Photos, voice-note transcription, and other media-derived facts are not
  guaranteed unless the relevant ingestion and extraction path records usable
  evidence for them.
- PropAI does not claim complete market coverage or infer demand/supply
  strength from small or workspace-limited samples.

## Product Change Contract

`PRODUCT.md` is the current product contract, not a permanent feature list.
When a user-visible capability, data boundary, processing guarantee, or
non-goal changes, update this file in the same change set as the implementation
or record the exception in `docs/DECISIONS.md`. Keep schema-specific fields and
operational commands in `DATA_QUALITY.md`, `ARCHITECTURE.md`, and service
runbooks; link to them rather than allowing this document to become an
unmaintainable API dump.

Before shipping a product change, verify:

- the source-of-truth and tenant boundary are still explicit;
- counters and status labels describe live data rather than pipeline guesses;
- raw evidence, normalized fields, and generated ranking signals remain
  distinguishable;
- public contact and crawlability rules remain intact; and
- the relevant docs and decision log no longer contradict the behavior.

## Accessibility & Inclusion

All interactive controls must be keyboard-navigable, and color must never be
the only status indicator. Images require meaningful alt text. Error states
must explain what failed and what the user can do next. Public pages should
remain crawlable and should not depend on client-only placeholders for their
core content.
