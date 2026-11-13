# Property identity and broker-offer design

Status: proposed design. This document does not authorize a migration, data
backfill, deployment, Gmail access, monitoring, broker outreach, or changes to
existing source permissions.

## Scope and governing decisions

The current product contract is tenant-private: every inventory record,
source message, contact, match, worker claim, and derived read must be scoped
to `tenant_id`. There is no shared market or public listing surface. Any
property identity work must preserve that boundary.

The existing typed listing tables remain the source-grounded extraction
records. The new layer groups those records into a stable physical-property
candidate and attaches broker-specific offers without rewriting source facts.

This design supersedes neither `source_fingerprint` nor
`author_content_fingerprint`:

- source fingerprints identify source items and extraction idempotency;
- author/content fingerprints identify exact repost observations;
- property identity identifies a hypothesized physical unit;
- broker offers preserve each broker's independently sourced quote and terms.

`opportunity_key`, `duplicate_status`, and `duplicate_group_id` remain
backward-compatible fields during rollout. They must not become the sole
property identity because they currently couple identity to broker/source
observations and do not provide a reversible relationship history.

## Proposed schema

The repository uses imperative Supabase migrations. A future migration should
add these tenant-scoped tables, with RLS enabled on each table and no
anonymous or ordinary cross-tenant access.

### `property_candidates`

Stable UUID for a hypothesized physical unit.

Required fields:

- `id`, `tenant_id`
- `identity_status`: `candidate`, `confirmed`, `unresolved`, `split`,
  `redirected`
- nullable `building_id`
- normalized unit facts: `floor`, `wing`, `flat_number`, `bhk`, and explicit
  area fields with their basis
- `first_seen_at`, `last_observed_at`
- redirect/split metadata, rule version, created/updated timestamps

### `property_source_fragments`

One source-scoped attachment for each exact unit/offer fragment.

- `property_id`, `tenant_id`
- `raw_message_id` and `listing_index`
- typed source discriminator and typed row ID
- source slice/reference, capture time, advertised time when known
- source scope and retention/deletion state

The source discriminator is needed because IDs in the eight typed tables are
only locally unique. The relationship must not weaken source permission checks.

### `property_offers`

One broker offer attached to a property candidate.

- `property_id`, `tenant_id`
- source fragment
- canonical `broker_id` plus source-provided broker identity evidence
- offer status and current offer summary
- quote amount, currency, period, deposit, maintenance, furnishing, parking,
  possession, restrictions, and other source-grounded terms
- `first_advertised_at`, `last_advertised_at`, `last_captured_at`

Different quotes and terms remain separate offers or revisions; they are not
averaged or overwritten.

### `property_field_claims`

Append-only field claims for values that may conflict.

- property/offer scope
- field name, raw value, normalized value, unit/basis
- source fragment, claim date, confidence, rule/model version
- `active`, `conflicting`, `superseded`, or `withdrawn` status

Carpet, built-up, usable, chargeable, and saleable areas must remain distinct
claim types.

### `property_match_relationships`

Reviewable candidate relationships.

- candidate A and candidate B, both tenant-scoped
- `possible_duplicate`, `confirmed_same_unit`, `confirmed_distinct`, or
  `rejected`
- supporting evidence and conflicts
- matcher/rule version, reviewer, timestamps
- reversible decision metadata

### `property_availability_events`

Offer/property-scoped availability observations. This should bridge the
existing `listing_availability_verifications` history rather than create a
second uncoordinated verification system.

An offer withdrawal does not make the property unavailable when other offers
remain. A repost updates advertisement freshness, not confirmation status.

## Identity policy

### Deterministic attachment

The first release may attach records automatically only when evidence is
strong and tenant-local:

- same verified unit identifier and building/address;
- same source-supported explicit statement that two adverts are the same unit;
- exact repost of the same source item under existing author/content rules.

Known different unit identifiers, floors, wings, or other hard contradictions
block automatic confirmation unless a separately sourced correction explains
the conflict.

### Review-only candidate generation

Candidate generation may use normalized building/address, transaction type,
asset type, BHK/layout, area plus basis, floor, wing, balcony/terrace, views,
parking, and source context. Rent, broker identity, reused wording, and
semantic similarity are weak evidence only.

Missing data is unknown, not a match and not a contradiction. Uncertain pairs
remain separate with a `possible_duplicate` relationship.

### No LLM identity authority

Existing deterministic extraction and source-boundary logic remains
authoritative. LLM or embedding output may rank candidates or explain a
review, but cannot create a property identity, authorize a merge, or disclose
restricted evidence.

## API proposal

Add authenticated, tenant-scoped workspace routes only after shadow-mode
evaluation:

- `GET /api/properties`
- `GET /api/properties/{property_id}`
- `GET /api/properties/{property_id}/offers`
- `GET /api/properties/{property_id}/claims`
- `GET /api/properties/{property_id}/possible-duplicates`
- `POST /api/property-match-reviews`
- `POST /api/property-match-reviews/{id}/resolve`
- `POST /api/properties/{property_id}/split`

Property-level pagination is required. Responses must distinguish first seen,
last advertised, last captured, availability checked, and availability
confirmed. Contacts and source references are filtered for the requesting
tenant and source scope.

Existing listing/search routes retain their current semantics until the new
read projection is proven equivalent for source access, counts, freshness, and
unit separation.

## Permission and retention requirements

Every table and route must enforce:

- resolved organization membership and non-null tenant scope;
- source/group/DM permission on every source fragment;
- explicit DM consent where applicable;
- contact visibility and server-side contact resolution;
- deletion, consent revocation, and retention propagation;
- fail-closed behavior when tenant or source scope is absent.

The current raw-message contract retains source rows for a bounded period.
Before creating durable property claims, product must decide whether to retain
governed source references/minimal evidence, extend raw retention, or mark
derived claims unavailable after source deletion. Audit records must not retain
content that retention policy requires removed.

Gmail remains out of scope until a separately authorized connector/import
architecture defines account scope, destination, retention, deletion, and
visibility rules.

## Migration and rollout

1. Resolve the contradictory legacy public/shared-market documentation and
   confirm that the target remains tenant-private.
2. Verify the live schema, migration history, RLS policies, views, grants, and
   retention jobs with authorized Supabase access. Do not infer live state from
   generated artifacts.
3. Add the new tables, constraints, indexes, and RLS policies without
   changing existing typed rows or read routes.
4. Create shadow source-fragment and offer attachments for authorized typed
   rows. Do not perform durable fuzzy merges.
5. Build a tenant-authorized labeled sample covering same-flat/multiple-broker,
   same-building/different-flat, changed rent, missing unit identity,
   multi-unit digests, and conflicting area bases.
6. Measure false merges and missed duplicates separately.
7. Release property-first reads behind a feature flag with possible duplicates
   and conflicts visible.
8. Enable only validated deterministic attachments.
9. Add reviewed confirmation, split, and redirect workflows.
10. Keep Gmail, alerts, monitoring, outreach, and public/shared presentation
    disabled unless separately approved.

Rollback is feature-flag disablement. New identity rows must remain auditable;
rollback must not require deleting or rewriting typed source records.

## Acceptance tests

- provider redelivery creates no additional source item or offer revision;
- the same confirmed flat advertised by three brokers returns one property and
  three source-backed offers;
- different known units in one building remain separate;
- unknown unit identity plus similar attributes creates a possible duplicate,
  not an automatic merge;
- each multi-unit fragment retains its own price, parking, restriction, and
  contact evidence;
- quote changes preserve dated claims and reposts do not confirm availability;
- carpet and built-up areas remain non-equivalent;
- requirements, sale adverts, forwarded summaries, signatures, and unrelated
  text do not become rental supply;
- revoked or denied source access cannot affect counts, summaries, contacts,
  caches, or cross-tenant results;
- a split restores each offer/source membership without losing history;
- property reads do not trigger writes, outreach, monitoring, alerts, or new
  source access.

## Open decisions before implementation

1. Confirm tenant-private scope versus any future shared-market product.
2. Define identity for commercial units and JODI/combined opportunities.
3. Decide whether sale and rent can share a physical property candidate.
4. Define source-retention behavior for durable claims.
5. Define who may confirm, merge, split, or redirect candidates.
6. Define the promotion rule from `candidate` to `confirmed`.
7. Define handling for conflicting unit numbers and source corrections.
8. Decide whether existing `opportunity_key` values are hints only or valid
   initial attachments.
9. Approve the labeled evaluation sample and false-merge target.

## Discovery evidence

- Existing typed destinations and live read models are documented in
  `docs/ARCHITECTURE.md`.
- Existing exact repost and deduplication rules are documented in
  `docs/DATA_QUALITY.md`.
- Existing opportunity identity is introduced by
  `supabase/migrations/20260816222159_canonical_opportunity_identity.sql`.
- Existing review fields are introduced by
  `supabase/migrations/20260813170000_near_duplicate_listing_reposts.sql`.
- Existing deterministic behavior is covered by
  `tests/test_canonical_opportunity_identity.py`.
- Local Supabase uses imperative migrations, Postgres 17, and public API
  schemas from `supabase/config.toml`.

## Verification limitation

No live Supabase schema/RLS query was performed in this pass. The installed
Supabase CLI attempted to write telemetry under `/home/vishal`, which is
read-only in this environment, and failed before completing its command. The
repository migration files and local configuration were inspected instead.
