# PropAI Data Quality and Identity Audit

Date: 2026-08-16
Status: Investigation only; no production writes or consent changes were made.

## Executive finding

PropAI currently has no single canonical opportunity-identity path. Three different mechanisms are being treated as dedupe, but they solve different problems:

1. `source_fingerprint` prevents retrying the same raw WhatsApp message.
2. `record_listing_repost()` classifies a saved row as `merged`, `flagged`, or `distinct`, but does not remove or canonicalize rows.
3. `_merge_observation_rows()` merges rows only in selected feed paths and is not used by every market/search consumer.

As a result, reposts remain physically stored and different screens expose different projections of the same data. More parsing or more semantic search will not solve this until canonical identity is shared by ingestion, storage, and every feed.

## Confirmed root causes

### 1. Typed-table uniqueness is source-level, not listing-level

The typed tables have a unique `source_fingerprint`. The application generates it from the raw message and listing index. A repost in a new WhatsApp message therefore receives a new fingerprint and a new typed row.

Relevant files:

- `storage/supabase.py` (`save_typed_observation`, typed save paths)
- `supabase/migrations/20260803020000_typed_extraction_schemas.sql`

This is ingestion idempotency, not property dedupe.

### 2. Repost classification does not produce one canonical row

`storage/supabase.py::record_listing_repost()` uses semantic candidates and structured comparisons, then writes duplicate metadata. For a `merged` result, both the old and new rows remain in the database. The function does not create a canonical opportunity record, redirect the new row, or remove it from all consumers.

Its rules are also too restrictive for reposts: same broker, exact normalized building text, same day for exact matches, and matching price/area/BHK. It fails on building aliases, missing fields, changed posting days, missing phones, and semantically equivalent wording.

### 3. Different screens use different feed implementations

`/api/inbox/items` uses `_get_recent_market_observations()` and `_merge_observation_rows()`.

`get_market_listings()` reads typed rows directly. It does not apply the same merge function and does not filter `duplicate_status = 'merged'`. It also reports `observation_count: 1` and `group_count: 1` per physical row.

Relevant files:

- `routers/workspace.py`
- `storage/supabase.py::get_market_items_feed`
- `storage/supabase.py::get_market_listings`
- `routers/search.py`

The old SQL dedupe migration targets the pre-typed `parsed_output` model and is not the canonical implementation for the current typed feeds.

### 4. The in-memory fingerprint omits broker identity

`storage/supabase.py::_observation_fingerprint()` is described as broker-scoped but does not include `broker_id`, broker phone, or broker name. This causes two opposite risks:

- real reposts fail to merge when other fields vary;
- different brokers advertising the same physical property can be merged incorrectly in paths that use this function.

The fingerprint also lacks a complete unit identity. Floor is partial; wing, flat/unit number, and configuration details are not consistently represented. The product rule is that building + unit + broker + transaction distinguish an opportunity; the implementation does not enforce that consistently.

### 5. Broker canonical identity and broker display name disagree

`storage/supabase.py::_resolve_whatsapp_display_name()` is preferred over extracted broker name, profile name, and sender name. The same preference is repeated while saving typed rows.

Therefore one phone can appear as different names such as `Kapil Gopal Ojha`, `Kapsy`, or another WhatsApp push name. A canonical `broker_id` may exist, but consumers still display the row-level `broker_name` instead of resolving the canonical broker name from `broker_id`.

Required model:

- normalized phone is the identity key;
- `broker_id` is the authoritative identity;
- push names and extracted signatures are aliases/evidence;
- display name comes from the canonical broker record;
- conflicting names are reviewable, not silently substituted.

### 6. Broker field validation allows body/CTA contamination

`extraction.py::_clean_broker_name()` rejects phones, WhatsApp links, and some contact/instruction phrases, but it does not reject arbitrary CTA or body text such as `Please share suitable options`.

The extraction schema does not make broker identity a strongly source-grounded field. Later fallbacks populate broker name from `sender_name` or `push_name`, so transport metadata can override the actual source signature.

Broker name must be accepted only when it is supported by a sender profile or an explicit source signature/contact block. CTA, property description, requirement text, and generic instruction phrases must be rejected or marked for review.

### 7. Source redaction is route-dependent

Market feed detail paths redact phone numbers through `_redact_market_source_text()`. The authenticated listing detail endpoint intentionally returns raw workspace evidence without redaction. This explains inconsistent source rendering across pages.

The product must explicitly separate:

- private evidence available to authorized internal users;
- public/source-safe text;
- broker contact action resolved server-side.

No page should accidentally render a raw payload as a public source slice.

### 8. WhatsApp ingestion/control plane can starve extraction

Production evidence previously showed webhook timeouts and 502 responses. The extraction worker also observed zero selected groups across three organizations: 356 groups existed, zero were selected, and all were opted out. This is an upstream control-plane problem, not merely an extraction-worker performance problem.

The group UI also showed `502` and “no directory available”. It must distinguish an unavailable directory from a genuinely empty directory and must not present fake empty-success states.

No consent rows should be changed automatically.

### 9. Building enrichment is functionally incomplete

The worker can run while producing no useful enrichment:

- Crawl4AI fails when the package is absent in the production image.
- Crawl4AI has a daily budget and defers jobs after exhaustion.
- Google Places requires a configured API key and quota.
- IGR, RERA, and OpenStreetMap providers contain explicit not-implemented paths.

Observed dashboard failures (`web_search_budget_exhausted`, missing Crawl4AI, 0% confidence) match the implementation.

### 10. Semantic retrieval is below the level required for dedupe

The observed golden-set results were recall@5 21.4%, recall@10 21.4%, MRR 0.161, building alias recall@5 12.5%, and broker alias recall@5 33.3%.

Near-duplicate discovery uses semantic search with a similarity threshold and then filters by broker phone and a seven-day window. At this recall level it cannot be the correctness-critical dedupe mechanism.

Semantic search should rank uncertain candidates only. Deterministic canonical identity must decide exact matches.

## Upstream reliability findings

- WhatsApp webhook requests have timed out while messages continued arriving.
- History-sync/reconnect spikes created a large raw backlog.
- Group consent selection is currently capable of suppressing all extraction while leaving raw evidence queued.
- Extraction worker health must report fetched, consent-suppressed, processed, failed, and remaining counts separately.

## Required repair order

### P0: canonical broker identity

Make `broker_id` authoritative for display. Store push names and source signatures as aliases/evidence. Add tests for the same phone appearing as multiple names and for CTA text being rejected as a broker.

### P0: one canonical market feed

All inbox, map, search, broker, and chat consumers must use one projection that:

- excludes merged physical rows;
- groups repost evidence under one canonical opportunity;
- retains first-seen, last-seen, and source evidence;
- keeps different floors/units separate;
- separates sale and rent;
- uses canonical broker and building identities.

### P0: deterministic opportunity identity

Identity should include transaction, asset type, canonical broker, canonical building where verified, unit/floor/wing/flat, BHK/configuration, area, price, and relevant furnishing/occupancy fields. Semantic retrieval may propose candidates but cannot be the final merge authority.

### P0: control-plane truthfulness

Fix group-directory refresh and 502 handling. Never display “empty” when the directory request failed. Keep all consent changes explicit and reviewable.

### P1: webhook durability

Use durable acknowledgement/outbox/retry behavior so API timeouts do not cause ingestion gaps, duplicate delivery confusion, or uncontrolled history-sync backlog.

### P1: enrichment gating

Do not queue unavailable providers. Make missing dependencies, keys, quotas, and stub providers visible as configuration state rather than endless enrichment failures.

### P1: semantic quality

Repair tenant scope, alias indexing, stale/orphan vectors, model consistency, and benchmark coverage before using semantic results in repost decisions.

### P1: retention

Review both `raw_messages.raw_payload` and typed-row payload copies before applying retention. Trimming only raw messages does not remove typed payload duplication.

## Acceptance criteria before calling this fixed

1. Same phone + same property posted multiple times produces one market opportunity with multiple evidence messages.
2. Same building but different floor/unit remains separate.
3. Sale and rent remain separate.
4. Broker display name is stable across all screens for the same canonical phone.
5. CTA/body text cannot become broker name.
6. Every market/search UI uses the same deduped projection.
7. `duplicate_status = merged` rows never appear as independent inventory.
8. Group directory failure is shown as failure, not zero groups.
9. Extraction metrics distinguish fetched, suppressed, processed, failed, and remaining.
10. Semantic retrieval is not required for deterministic exact identity.

## Audit execution notes

No production writes, consent updates, migrations, deployments, or destructive cleanup were performed during this audit.

Dependency-independent focused tests passed: 20 tests. Broader extraction/storage tests could not be collected in the current environment because project dependencies such as `pandas` were unavailable and the default Python module path was not configured. Existing dirty worktree files were preserved.
