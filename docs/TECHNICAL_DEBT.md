# PropAI Technical Debt Register

**Last reviewed:** 2026-09-09
**Purpose:** A living, evidence-backed backlog for reducing reliability,
correctness, operability, and maintenance risk in PropAI.

This is a prioritisation document, not a list of every imperfect function.
Items should be closed only when the acceptance criteria and the production
verification evidence are attached to the task completion report.

## How to use this register

Work on one debt item at a time unless two items share the same migration or
deployment boundary. Every item needs:

1. a narrowly scoped change;
2. regression tests or a read-only verification query;
3. a deployed worker/API/UI check when the item affects production;
4. before/after queue or error evidence where applicable;
5. an update to this document and `architecture.md` when an invariant changes.

Statuses:

- **Open** — not safe to rely on in production.
- **Mitigated** — a guard exists, but the underlying debt remains.
- **In progress** — an explicitly scoped task is underway.
- **Verified** — acceptance criteria and production evidence are complete.

## Priority order

### P0 — correctness and truthful operation

| ID | Debt | Why it matters | Evidence | Acceptance criteria |
| --- | --- | --- | --- | --- |
| TD-001 | **No single canonical opportunity identity** | Reposts can remain as separate cards, while different consumers apply different merge rules. This causes duplicate inventory and inconsistent counts/search results. | `docs/PROPai_DATA_QUALITY_AUDIT_2026-08-16.md`; `storage/supabase.py`; `routers/workspace.py`; `routers/search.py` | One documented projection is used by inbox, search, map, broker, chat, and public listing reads. Reposts share canonical evidence without merging different units, floors, sale/rent records, or brokers. `duplicate_status = merged` rows never render as independent inventory. |
| TD-002 | **Legacy and typed data models coexist** | Compatibility adapters and legacy IDs make it possible for a row to be routed or interpreted differently across API, workers, matching, and UI. | `storage/supabase.py` (11k+ lines); 324 Supabase migrations; `architecture.md` landmine log | Each remaining legacy path has an owner and removal date, or is explicitly declared a read-only compatibility boundary. Typed table + typed row identity is authoritative end-to-end. |
| TD-003 | **Production health can be green while work is not progressing** | Coolify “running” proves container liveness, not queue consumption, successful work, or freshness. | `docs/PROPai_FRESH_OPERATIONAL_AUDIT_2026-09-02.md`; `routers/audit.py`; `architecture.md` | Every worker reports service version, heartbeat, last successful work, queue age, rows processed, last error, and effective configuration. Admin screens consume these live values; hardcoded counters are removed or deprecated. |
| TD-004 | **Matcher / Auto Matched lacks end-to-end proof** | A visible feature can appear available while producing no match rows or writing incompatible identities. | `docs/PROPai_FRESH_OPERATIONAL_AUDIT_2026-09-02.md`; `matching/worker.py`; `matching/service.py` | A controlled tenant test proves save requirement → worker claim → score → typed `requirement_matches` row → UI result. Logs show the dedicated matcher command and no legacy-FK identity errors. |

### P1 — usable inventory and pipeline throughput

| ID | Debt | Why it matters | Evidence | Acceptance criteria |
| --- | --- | --- | --- | --- |
| TD-005 | **Review quarantine is too broad** | Safety flags protect the public feed, but the documented audit found about 99.9% of listing rows marked `needs_review`; this leaves little usable inventory. | `docs/PROPai_FRESH_OPERATIONAL_AUDIT_2026-09-02.md`; `extraction.py`; `storage/supabase.py` | Review reasons are classified and counted. False-positive rules are corrected with fixtures. Auto-clear is allowed only for explicit evidence-backed reasons; existing rows are not mass-cleared merely to improve counters. |
| TD-006 | **Historical reprocessing has a large, low-yield backlog** | Paid model calls and worker capacity can be consumed by rows that cannot be repaired, while operators lack a clear terminal reason. | Fresh audit snapshot: 36,688 queued, 5,270 unresolved, 11,692 no-source, 2,202 failed. `extraction_reprocessing_worker.py` | Queue age, success rate, failure reason, provider, and terminal state are visible. A bounded sample demonstrates materially improved fixed-rate and no repeated retry churn. |
| TD-007 | **Extraction boundary repair is not operationally proven** | The repair worker exists in source, but a deployed heartbeat and queued → running → completed/no-split transition were not verified. | `docs/PROPai_FRESH_OPERATIONAL_AUDIT_2026-09-02.md`; `extraction_repair_worker.py` | Coolify resource, command, heartbeat, and one representative job transition are captured. UI distinguishes repaired, no split needed, failed, and stale. |
| TD-008 | **Requirement source evidence is incomplete historically** | The audit found 8,838 requirement rows whose `raw_message_id` did not resolve, violating the evidence-preservation expectation. | `docs/PROPai_FRESH_OPERATIONAL_AUDIT_2026-09-02.md`; typed requirement storage paths | Every orphan is classified as restorable, migrated/deleted, or quarantined. No replacement evidence is fabricated. UI clearly marks unavailable source evidence. |
| TD-009 | **Building enrichment depends on fragile provider setup** | Google Places, Crawl4AI/browser binaries, quotas, and incomplete provider paths create expensive retry noise and unclear operator actions. | `building_enrichment_worker.py`; `requirements.discovery.txt`; `docs/PROPai_DATA_QUALITY_AUDIT_2026-08-16.md` | Provider availability is checked before queueing. Missing keys, quota, dependency, and unsupported-provider states are explicit terminal/configuration states. Retryable and terminal failures have separate policies. |
| TD-010 | **Webhook and queue durability are not fully hardened** | Timeouts, reconnect/history-sync spikes, and control-plane suppression can produce duplicate-delivery confusion or backlog growth. | `docs/PROPai_DATA_QUALITY_AUDIT_2026-08-16.md`; `services/whatsmeow-ingestor/`; `routers/infra.py` | Ingestion acknowledges durably, retries through an explicit outbox/claim path, and exposes received/queued/processed/suppressed/failed counts. Group-directory failure never appears as an empty-success state. |

### P2 — maintainability, performance, and operator experience

| ID | Debt | Why it matters | Evidence | Acceptance criteria |
| --- | --- | --- | --- | --- |
| TD-011 | **Parser policy is distributed across too many authorities** | LLM extraction, deterministic validators, evidence gates, repair paths, and UI mirrors can disagree about item boundaries or field ownership. | `extraction.py`; `ai_extraction.py`; `extraction_models.py`; `scripts/`; `architecture.md` | One backend pipeline is authoritative. Other layers are explicitly validation or presentation only. A fixture traces raw broadcast → typed rows → UI source slices. |
| TD-012 | **Semantic search maintenance is below reliability needs** | Semantic retrieval is useful for ranking but has low documented alias recall and has experienced statement timeouts; it must not become accidental dedupe authority. | `docs/PROPai_DATA_QUALITY_AUDIT_2026-08-16.md`; `semantic_embedding_worker.py`; `tests/test_semantic_embeddings.py` | Backfill is bounded and indexed, stale/running jobs are visible, model/dimension versions are consistent, and semantic results remain ranking-only. |
| TD-013 | **Expected idempotency races are logged like failures** | Duplicate claim conflicts pollute error rates and hide real extraction failures. | `docs/PROPai_FRESH_OPERATIONAL_AUDIT_2026-09-02.md`; `storage/supabase.py`; `extraction_worker.py` | Claim races are an explicit skipped/idempotent metric. Malformed model output and persistence failures remain actionable errors with source/provider provenance. |
| TD-014 | **Admin pipeline list is not a real work queue** | The current review list is long, scroll-heavy, and difficult to filter or return to; low-contrast actions reduce operator throughput. | Production screenshots supplied on 2026-09-09; `frontend/src/app/admin/pipeline-health/` | Server-side pagination, search, status/error/provider/age filters, stable row actions, clear contrast, and persistent queue context. Review/edit → enrich should open with the source evidence and preserve the operator’s place. |
| TD-015 | **Worker lifecycle code is repetitive and failure-prone** | Several services implement independent infinite polling loops and broad exception handling, making backoff, shutdown, leases, and metrics inconsistent. | `app.py`; `extraction_worker.py`; `building_enrichment_worker.py`; `semantic_embedding_worker.py`; `matching/worker.py` | Shared worker lifecycle conventions cover leases, stale-job recovery, exponential backoff, graceful shutdown, structured errors, and heartbeat emission. |
| TD-016 | **Deployment and dependency reproducibility is uneven** | API images include browser/runtime tooling; frontend projects use separate npm/pnpm lock ecosystems; worker command drift has already caused operational risk. | `Dockerfile.api`; `Dockerfile.worker`; `Dockerfile.matcher`; `Dockerfile.www`; `frontend/package-lock.json`; `apps/www/pnpm-lock.yaml` | Each service has a pinned dependency/build contract, immutable startup command, smoke test, and CI build. Effective deployment configuration is visible in health output. |
| TD-017 | **CI does not provide one repository-wide safety gate** | There is extensive test coverage, but no obvious unified workflow that runs backend, frontend, public-site, Go, migration, and architecture checks together. | `.github/workflows/architecture.yml`; package scripts; `tests/` | Pull requests run the relevant test/build matrix with optional-dependency handling, migration/static checks, and `git diff --check`. Failures cannot be reported as passing. |
| TD-018 | **Retention and payload duplication need a deliberate policy** | Raw messages and typed rows can both retain large payload copies, increasing storage and privacy exposure. | `docs/PROPai_DATA_QUALITY_AUDIT_2026-08-16.md`; `architecture.md` | A retention policy identifies the authoritative evidence copy, legal/product requirements, redaction boundaries, and deletion/quarantine behavior. A dry-run report precedes any destructive cleanup. |
| TD-019 | **External-service and vendor coupling is broad** | Supabase, Google Places, multiple LLM providers, OpenRouter, Crawl4AI, Google Drive, OpenClaw, and Coolify all influence runtime behavior. | `deploy/coolify/docker-compose.yml`; `requirements*.txt`; `architecture.md` | Each provider has a documented contract, timeout, quota/error state, fallback policy, and cost owner. Provider failure never fabricates success. |

## Recommended execution sequence

1. **TD-003:** make worker and queue health truthful.
2. **TD-001:** define the canonical opportunity projection and identity.
3. **TD-002:** isolate and retire legacy identity/read paths.
4. **TD-004:** prove matching end to end.
5. **TD-005–TD-008:** reduce review and repair backlogs without weakening evidence rules.
6. **TD-009–TD-010:** harden enrichment and ingestion durability.
7. **TD-011–TD-013:** simplify policy ownership and error metrics.
8. **TD-014:** turn Pipeline Health into a filterable, paginated operator queue.
9. **TD-015–TD-019:** standardize worker lifecycle, builds, CI, retention, and provider contracts.

## What is not debt

These are intentional product constraints and should not be “fixed” as
technical debt:

- never auto-merging listings merely because the building matches;
- preserving raw WhatsApp evidence;
- keeping private CRM separate from shared market inventory;
- requiring review before uncertain building enrichment;
- keeping semantic retrieval as a ranking aid rather than an identity authority;
- hiding broker phone numbers from public HTML.

## Debt-task template

```md
### TD-XXX — <short title>

- Scope:
- Owner:
- Status:
- User-visible failure:
- Root cause:
- Files/services:
- Tests or queries:
- Production evidence:
- Acceptance criteria:
- Rollback/safety plan:
- Next action:
```

## Source documents

- [`docs/PROPai_DATA_QUALITY_AUDIT_2026-08-16.md`](PROPai_DATA_QUALITY_AUDIT_2026-08-16.md)
- [`docs/PROPai_FRESH_OPERATIONAL_AUDIT_2026-09-02.md`](PROPai_FRESH_OPERATIONAL_AUDIT_2026-09-02.md)
- [`docs/DATA_QUALITY.md`](DATA_QUALITY.md)
- [`architecture.md`](../architecture.md)
- [`docs/TASK_COMPLETION_REPORT.md`](TASK_COMPLETION_REPORT.md)
