# PropAI Living Architecture

This is the operational architecture contract for PropAI. It records rules
that are easy to rediscover incorrectly from code alone. Generated diagrams
live in [`docs/architecture/generated/`](docs/architecture/generated/); this
file is the hand-maintained layer and must change with architectural changes.

Generated artifacts are intentionally evidence-labelled. A schema diagram
generated without Supabase credentials is a source fallback, not proof of the
live database. Regenerate with `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` before treating it as current.

## System map

### WhatsApp ingestion and consent

The isolated WhatsMeow ingestor captures raw WhatsApp events and sends them to
the FastAPI ingestion boundary. Raw messages retain tenant, group, sender,
timestamp, and source evidence. Group selection, opt-out, pause, and stop
controls decide whether a raw message is eligible for extraction; eligibility
does not delete historical evidence. Main entry points are
`services/whatsmeow-ingestor/`, `routers/infra.py`, `routers/whatsapp_sync.py`,
and `routers/whatsapp_group_controls.py`.

### Extraction and typed persistence

`extraction_worker.py` claims eligible raw messages, splits independent
broadcast slices, calls the configured extraction model, applies deterministic
grounding and plausibility checks, and persists one of the eight typed listing
or requirement tables. `extraction.py` owns persistence and source-boundary
rules; `ai_extraction.py` owns model/schema prompts and normalization. The
typed tables are write sources; `listings_unified` and `requirements_unified`
are live read projections.

Extraction provider order is deployment-configured and quality-gated: when the
OpenRouter extraction variables are present, `openrouter/free` is attempted
first, the configured OpenRouter DeepSeek model is the next fallback, and
Doubleword remains the paid fallback. Every provider response still passes the
same JSON parsing, source-grounding, deterministic routing, and plausibility
checks before typed persistence; provider success alone never authorizes an
inventory write.

Broker directory aggregates are derived from all eight typed listing and
requirement tables. The removed `parsed_output` table is never a broker
directory source. Legacy broker graph tables are rebuildable presentation
cache; typed rows and their source evidence remain authoritative.

### Enrichment and locality/buildings

Deterministic locality normalization runs during extraction and correction.
`building-enrichment-worker` processes bounded `building_enrichment_jobs` and
stores evidence separately from the canonical building registry. Building
aliases are searchable evidence, not permission to merge distinct properties.
Main entry points are `location.py`, `building_enrichment_worker.py`,
`agents/building_enrichment/`, and `frontend/src/app/buildings/`.

### Search and semantic indexing

Structured search uses typed fields and is the correctness path. The optional
`semantic-embedding-worker` consumes `semantic_embedding_jobs`, stores
privacy-clean vectors in `semantic_embeddings`, and exposes tenant-aware
retrieval through `match_semantic_embeddings`. Semantic similarity can improve
recall or ranking; it cannot create inventory, merge identities, or authorize
contact. Main entry points are `semantic_embeddings.py`,
`semantic_embedding_worker.py`, `routers/search.py`, and `routers/ai_chat.py`.

### Matching

`matching/requirement_listing_matcher.py` scores active requirements against
active listings using explainable facts. `matching/service.py` reads the live
unified views and upserts `requirement_matches`; `matching/worker.py` is the
polling backstop across active tenants. Save-triggered matching should reuse
the same scorer and cap logic. A match is a broker-review suggestion, not a
deal or an automatic merge.

### Frontend surfaces

`frontend/` is the authenticated workspace at `app.propai.live`; its App
Router pages call the FastAPI API and expose operational controls, evidence,
My Deals, Auto Matched, and admin health. `apps/www/` is the public discovery
surface at `www.propai.live`; it must remain source-safe, crawlable, and free
of phone numbers in HTML. Deployment wiring lives under `deploy/coolify/`.

## Data model conventions

| Rule | Why it exists |
| --- | --- |
| Requirements use `budget_min`/`budget_max`; a requirement does not have a single listing-style `price` contract. | A demand range must not be collapsed into a supply price; doing so caused save/edit and matching failures. |
| Listings use `price`, with `price_unit`, `price_model`, and optional `price_per_sqft`; PSF input is not automatically a total price. | Rent, sale, and PSF values have different units and must not be compared without normalization. |
| A typed listing table is authoritative for transaction display: `*_rent_listings` renders Rent and `*_sale_listings` renders Sale, even if a legacy discriminator disagrees. | Compatibility fields can be stale after extraction or schema repair; trusting them misroutes rental inventory into sale. |
| If a typed listing has no normalized numeric price, the feed may normalize its explicit `price_raw_text`; it must not invent a price from arbitrary prose. | This keeps source-grounded price visibility useful while preserving the evidence contract. |
| `listings_unified` and `requirements_unified` are plain live `VIEW`s over typed tables. | A saved typed row is query-visible immediately; “refresh lag” is not a valid explanation until the view definition is rechecked. |
| Every cross-record match and query carries an unconditional tenant rule; null never equals null for isolation. | A missing tenant is unsafe data, not a global tenant, and must never become cross-workspace visibility. |
| Shared inventory is explicit (`visibility = shared_market`); it is not inferred from a missing tenant. | Shared-network visibility must be auditable and cannot turn bad tenant data into public inventory. |
| Workspace shortlist/pipeline rows are tenant-owned references (`workspace_market_candidates`) to a typed source table/id; they never copy, merge, or mutate shared market evidence. | Brokers can organize shared opportunities in My Deals without turning a market observation into private CRM inventory or fabricating a new listing. |
| Saved Inbox searches are tenant-scoped query definitions with a source-time cursor (`saved_market_searches.last_seen_record_at`); WABA alert delivery remains a separate opt-in workflow. | Search persistence must distinguish new evidence from previously viewed results without implying that a saved query is a complete market alert. |
| Raw message, normalized field, and inferred/enriched field remain distinguishable. | The original evidence is the audit trail and prevents an enrichment guess from becoming fabricated inventory. |
| Raw-message idempotency is unique per `(tenant_id, message_uid, source)` for inbound WhatsApp paths. | A retry in one workspace is deduplicated without allowing one tenant's message UID to suppress another tenant's evidence. |
| Locality grounding accepts only a labelled location or one unambiguous canonical locality in the item slice; bare parent names remain generic, and market filters compare canonical locality keys only (never building names/substrings). | Broadcast context can misclassify a property and building names can contain locality words; precision avoids moving inventory into the wrong micro-market. |
| Explicit inventory markers outrank incidental business names, landmarks, and suitability phrases when generating titles. | A residential BHK message mentioning “Near Tawa Restaurant” must not become a restaurant listing; titles remain source-grounded and reviewable. |
| Same building does not identify the same unit; no automatic merge. | Reposts, floors, wings, and units can be different opportunities even when the building name matches. |
| Requirement reposts may be collapsed only in the market-feed projection when the same broker, asset/transaction, title, and strong structured anchors agree; missing optional fields do not split the demand signal. | A repeated requirement can be parsed once with area/furnishing/building context and once without it. This projection-level collapse keeps the richest evidence visible without auto-merging supply listings or deleting source rows. |
| Building presentation/grouping keys are case-insensitive and derived from canonical identity. | `Bandra West`, `bandra west`, and source casing must not create duplicate cards. |
| Broker blocks are workspace-scoped and reversible; they hide feed results but do not delete raw evidence or change another tenant. | A broker relationship preference is a view control, not destructive data mutation. |
| Public HTML never contains phone numbers; contact resolution is server-side after user action. | Protects broker privacy and the public crawlability contract. |
| Pipeline stages are independently observable: ingestion, extraction, enrichment, semantic indexing, and matching. | A healthy worker heartbeat proves liveness, not complete coverage of every row. |
| Intelligence claims state scope, coverage, time window, freshness, and source count; partial captured data is descriptive, not a market census. | Prevents a small or tenant-scoped sample from being presented as “high demand,” “low supply,” or another unsupported market conclusion. |
| Deterministic splitters must recognize the broker's structural boundaries before the LLM sees a slice, including numbered forms such as `1/` and a narrow, explicit asset heading such as `Office Available For Sale`. | A single WhatsApp broadcast can contain several unrelated properties and intents; sending the whole broadcast as one extraction corrupts inventory quality and transaction classification. |
| Market-feed totals are bounded recent-window counts and are optional for rendering the 50-card page. | Counting across every typed table must not make the live feed fail, and a bounded count must never be presented as a database-wide census. |
| Property-scale price corruption must never become public inventory. | The typed persistence boundary quarantines impossible sale/rent totals, the repair migration handles historical rows, and public listing queries exclude `needs_review` rows while retaining source evidence for review. PSF rates remain a separate field. |

## Intelligence and evidence contract

PropAI may claim only what the selected evidence can measure. Every user-facing
metric or insight must retain:

- metric definition and units;
- numerator/denominator where relevant;
- tenant, workspace, group, and locality scope;
- time window and comparable baseline, if a change is shown;
- source record count and last-updated time;
- coverage or limitation note.

“Observed” language is the default: “12 requirements captured in the last 7
days” is valid; “demand is high” is not. Market-wide labels such as high
demand, low supply, most active broker, best locality, or rising prices require
a documented method, sufficient sample size, and comparable coverage. LLMs can
explain computed facts but cannot promote them into unsupported conclusions.

## Known landmines and open risk log

Status values: **resolved** means the invariant has a code/test or migration
guard; **mitigated** means a guard exists but the underlying class of risk
still needs monitoring; **open** means verify before relying on it.

| Status | Landmine | Current guard / required verification | Commit or reference |
| --- | --- | --- | --- |
| resolved | Requirement/listing matching once enforced tenant isolation only when the requirement tenant was truthy. | Matcher rejects missing either tenant; focused null-never-matches-null test exists. | `2fde8e0e`, `tests/test_requirement_listing_matching.py` |
| resolved | Requirement budget fields were confused with listing `price`. | Typed schemas, UI, and matcher use `budget_min`/`budget_max`; keep this rule in any new API. | `da30d77d`, `3701cfae` |
| resolved | My Deals correction re-classified an already-typed requirement as a listing because typed requirement rows do not carry legacy `intent`/`message_type` discriminators. | Correction storage now derives asset, transaction, and requirement kind from the source typed table; regression tests cover all four route families. | `tests/test_typed_schema_cutover.py` |
| mitigated | Building display grouping could split records by casing. | Registry dedupe and presentation keys normalize case; rerun duplicate query after locality/building changes. | `apps/www/src/lib/building-intelligence.ts`, `apps/www/src/lib/localities.ts` |
| mitigated | AI price extraction is non-deterministic for PSF-style input. | Deterministic downstream price/unit and plausibility guards reject or flag implausible totals; verify before price-sensitive ranking. | `d27f39eb`, `matching/requirement_listing_matcher.py` |
| mitigated | Market cards could trust a stale transaction discriminator and omit an explicit raw price. | Feed projection now uses the typed table route and deterministic `price_raw_text` fallback; keep regression coverage and audit historical rows separately. | current working change, `tests/test_market_feed_card_projection.py` |
| open | Nested `ai_extraction.extraction_confidence` can disagree with the top-level confidence column. | `canonicalize_extraction_confidence` and persistence normalize current writes; audit historical rows and every consumer before declaring resolved. | `a5dc4c22`, `extraction_quality.py` |
| resolved | `requirements_unified` was suspected to be materialized. | Migration defines a plain `VIEW`; matching reads it live. Recheck with the verification query below if save visibility appears delayed. | `supabase/migrations/20260803040000_cutover_typed_application_reads.sql` |
| resolved | Semantic retrieval could treat null tenant vectors as globally visible. | Latest migration allows workspace rows only for the tenant, explicit shared inventory, or global locality data; no-tenant mode is reserved for protected Super Admin probing. | `2f421d65`, `supabase/migrations/20260823120000_fail_closed_semantic_tenant_scope.sql` |
| mitigated | Semantic indexing is optional and can be disabled or unconfigured while structured search continues. | Worker heartbeat reports `running`, `degraded`, or `stopped`; never infer health from a deployed container. | `b7fa0608`, `semantic_embedding_worker.py` |
| mitigated | Extraction live mode deliberately leaves historical backlog untouched. | Coolify worker configuration and UI must label live-only scope; replay requires an explicit bounded operation. | `docs/DATA_QUALITY.md`, `extraction_worker.py` |
| mitigated | Locality classification can over-trust an AI guess, force a direction from a bare parent market, or match a building name as if it were locality evidence. | Forward extraction accepts only labelled or unambiguous source-locality signals; bare parents stay generic; feed filters use exact canonical locality keys. Historical repair is report-only until a reviewed dry run is approved. | `extraction.py`, `location.py`, `storage/supabase.py`, `scripts/locality_backfill_dry_run.py` |
| mitigated | Mixed WhatsApp broadcasts using slash-numbered rows or a clear unnumbered asset section could bypass deterministic slicing and become one giant listing. | Splitter recognizes `1/`-style boundaries and narrowly defined asset-plus-intent section headers; regression coverage uses the observed multi-property broadcast shape. | `deterministic_splitters.py`, `tests/test_deterministic_splitters.py` |
| mitigated | The optional Market Inbox total query could fan out thousands of rows per typed table and turn a healthy page request into a 500. | Count is capped to a recent bounded window and the API falls back to the normal page with an explicit unavailable total. | `storage/supabase.py`, `routers/workspace.py` |
| open | Auto Matched production end-to-end behavior still needs a real save → match → UI verification after deploy. | Run the playbook below after migration and app/worker redeploy; focused matcher tests are not production proof. | `matching/worker.py`, `matching/service.py` |

## Verification playbook

These checks are intentionally copy-pasteable. Run read-only queries through
the existing Supabase SQL bridge or a trusted Postgres connection. Never put
service keys in this file or in shell history shared with others.

### Confirm the unified requirement model is a live view

```sql
select table_name, table_type
from information_schema.views
where table_schema = 'public'
  and table_name in ('listings_unified', 'requirements_unified');
```

### Find cross-tenant requirement matches

```sql
select rm.id, rm.requirement_id, rm.listing_id,
       r.tenant_id as requirement_tenant, l.tenant_id as listing_tenant
from requirement_matches rm
join requirements_unified r on r.id = rm.requirement_id
join listings_unified l on l.id = rm.listing_id
where r.tenant_id is null
   or l.tenant_id is null
   or r.tenant_id <> l.tenant_id;
```

Expected result: zero rows. Null is a violation, not a match.

### Review historical locality repairs without writing data

The following command is deliberately read-only. It scans affected typed rows,
shows the actual locality beside the source text and proposed source-grounded
locality, and marks only clear proposals as eligible. Share and review the
report before any future backfill write; do not add an apply flag to this
script.

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \\
  python scripts/locality_backfill_dry_run.py \\
  --sample 250 --output locality-review.json
```

Expected result: the report contains `raw_source`, `actual_locality`,
`proposed_locality`, and `eligible_for_backfill`; the command writes only the
local report file and never updates Supabase.

### Find duplicate building display keys within a tenant and locality

```sql
select tenant_id, lower(trim(canonical_name)) as display_key,
       lower(trim(coalesce(micro_market, ''))) as market_key,
       count(*) as rows
from buildings
group by tenant_id, lower(trim(canonical_name)), lower(trim(coalesce(micro_market, '')))
having count(*) > 1
order by rows desc;
```

### Inspect PSF price plausibility samples

```sql
select id, tenant_id, price, price_unit, price_model, price_per_sqft,
       area_sqft, price_raw_text, needs_review, extraction_confidence
from listings_unified
where price_per_sqft is not null and area_sqft is not null
  and price is not null
  and abs(price - price_per_sqft * area_sqft)
      > greatest(price * 50, 1000000)
order by updated_at desc
limit 100;
```

### Check confidence distribution against populated price/area

This catches a source-evidence regression that labels otherwise populated
rows low merely because a brittle source regex failed. A normal day should
return to roughly 50–60%+ high-confidence rows (subject to the day's data
mix), with populated price/area counts visible alongside each bucket.

```sql
select date_trunc('day', updated_at) as day,
       extraction_confidence,
       count(*) as rows,
       count(*) filter (where price is not null) as rows_with_price,
       count(*) filter (where area_sqft is not null) as rows_with_area
from listings_unified
where updated_at >= now() - interval '48 hours'
group by 1, 2
order by 1 desc, 2;
```

Expected result: only reviewed/known exceptions. A large unexplained result
means the deterministic guard or a typed projection has regressed.

### Price plausibility guard

The extraction boundary must validate the model's output rather than re-decide
whether raw text contains a narrow price keyword. When a rate and area are
available, check their arithmetic against the extracted total. Also check that
an extracted numeric value is loosely traceable to the source text, allowing
for commas, lakh/crore notation, and formatting differences. A failed check
sets `needs_review` and lowers confidence but does not erase the extracted
value; reviewers need to see what the model found. Do not restore the blanket
price-evidence regex gate.

### Tenant-scoped raw ingestion and deduplication

Raw-message UID deduplication is scoped by `tenant_id`; the same WhatsApp UID
must not be used as a cross-tenant lookup key. Webhook, WABA, self-chat, AI
Chat, repair, and manual-save paths must resolve the active tenant before
deduplication or persistence. If tenant resolution or a duplicate lookup
fails, the path fails closed rather than inserting an unscoped row. Internal
extraction triggers require the shared internal token and an explicit tenant.

### Check confidence disagreement in recent typed rows

```sql
select id, tenant_id, extraction_confidence,
       ai_extraction->>'extraction_confidence' as nested_confidence,
       ai_extraction->>'extraction_confidence_score' as nested_score
from listings_unified
where coalesce(ai_extraction->>'extraction_confidence', '') <> coalesce(extraction_confidence, '')
order by updated_at desc
limit 100;
```

### Check worker liveness and stage coverage

```sql
select worker_name, status, heartbeat_at, last_error, config
from worker_heartbeats
order by worker_name;
```

Compare worker heartbeat with stage counts, not with deployment labels:

```sql
select status, count(*) from semantic_embedding_jobs group by status order by status;
select status, count(*) from building_enrichment_jobs group by status order by status;
```

### Verify newest requirement matching backstop

```sql
select id, tenant_id, created_at, updated_at
from requirements_unified
where status = 'active'
order by created_at desc
limit 50;
```

After a fresh requirement save, its ID should be included in the next scoped
run and its `requirement_matches` rows should have the same tenant.

## Decision log

### 2026-08-25 — Chat-first private CRM intake

**Context:** Brokers already describe inventory naturally in chat and rejected
form-first CRM entry. Treating a normal save instruction as a market write
would also risk exposing broker-owned inventory without a deliberate choice.

**Decision:** Route listing captures from chat to the tenant-scoped
`save_private_inventory` flow by default. The assistant prepares a draft and
requires explicit confirmation before writing `crm_inventory`. Only a clearly
requested publish/share-to-market action may use the shared market save path.

**Consequence:** Chat remains the fastest intake path, while private inventory
is isolated from Market Inbox, public discovery, semantic search, and Auto
Matched unless the broker explicitly publishes it.

### 2026-08-25 — Private CRM inventory is not market inventory

**Context:** Brokers need an internal inventory tool for records they own or
manage, including CSV imports, without sharing those records with the PropAI
market.

**Decision:** Store Private CRM rows in a separate tenant-scoped table. Every
read and write filters `tenant_id` unconditionally; CRM rows have no WhatsApp
evidence claim and do not enter market feeds, public pages, semantic search,
or Auto Matched. Manual and AI-assisted entry are draft-first; AI only returns
an editable suggestion, and an explicit broker save is required. A future
publish action must be explicit and reviewed.

**Consequence:** Brokers can organize private inventory safely while the
market remains grounded in captured evidence.

**Attachment rule:** Chat uploads use the private `private-crm` storage bucket
and `crm_inventory_attachments`, under an authenticated tenant/user prefix.
They are linked to CRM inventory only after explicit confirmation and never
enter Market Inbox, semantic search, or Auto Matched.

### 2026-08-23 — Living architecture stays self-hosted

**Context:** Architecture facts were living in conversation history and
static markdown was becoming stale.

**Decision:** Generate schema and dependency Mermaid artifacts from repository
source plus live Postgres introspection, expose them through an authenticated
workspace page, and use a non-blocking CI warning for architecture-sensitive
changes. No external documentation SaaS or proprietary renderer is used.

**Consequence:** Generated files are disposable and labelled with their source;
`architecture.md` remains the durable human/agent contract and must be updated
for invariant changes.

### 2026-08-23 — Observed evidence before market claims

**Context:** The workspace now has meaningful captured data, but its coverage
is still limited by connected accounts, selected groups, tenant scope, and
time windows.

**Decision:** Product analytics uses descriptive, scoped metrics by default.
Market-wide demand, supply, broker-activity, popularity, and price-direction
claims require a documented method, sufficient sample size, and comparable
coverage. LLMs may explain measured facts but may not invent the conclusion.

**Consequence:** Users get auditable counts and distributions with explicit
scope and freshness instead of false certainty from a partial feed.

### 2026-08-12 — Embeddings are a ranking aid, not identity

**Context:** Semantic search helps aliases and natural language but cannot
prove that two listings are the same opportunity.

**Decision:** Keep deterministic source, tenant, locality, and identity rules
stronger than vector similarity; run embeddings asynchronously.

**Consequence:** Structured search and evidence remain valid when the semantic
worker is stopped or incomplete.

### 2026-07-15 — Supabase over raw Postgres

**Context:** The product needs managed Postgres, auth, RLS, and operational
inspection without adding a second persistence abstraction.

**Decision:** Use Supabase as the database/auth boundary, with protected SQL
bridge functions for bounded complex reads.

**Consequence:** Schema generation uses the same protected bridge and must use
service credentials only in CI/deploy environments.

### 2025-07 — Ink/parchment/signal theme; light app, dark sidebar

**Context:** Workspace scanning benefits from a calm light canvas while the
sidebar needs strong wayfinding contrast and brand anchoring.

**Decision:** Keep the primary workspace light parchment and the navigation
dark ink; use signal/olive only for action, status, and selection.

**Consequence:** UI changes should reuse `unified-tokens.css` semantic roles,
not introduce arbitrary new colors or invert the entire app.

## Maintenance contract

Any change that modifies a data model invariant, tenant boundary, pipeline
stage, source-of-truth rule, matching behavior, consent behavior, or a listed
landmine must update this file in the same commit as code and tests. Generated
Mermaid files are regenerated by the architecture workflow and must not be
hand-edited. The warning is intentionally non-blocking, but ignoring it is a
bus-factor risk.
