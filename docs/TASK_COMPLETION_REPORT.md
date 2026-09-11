# Task Completion Report

This is the mandatory handoff log for every agent task in PropAI.

## 2026-09-10 — Production extraction corpus audit and replay corpus builder

- Requested outcome: Compare the largest available raw WhatsApp corpus with saved Sarvam extraction results, identify recurring failure families, and recommend a hardening path.
- Outcome: Completed a read-only production audit and added `scripts/build_extraction_replay_corpus.py`, which builds a stratified local JSONL evaluation manifest keyed by `raw_message_id:listing_index`. The corpus contained 831,213 raw messages and 54,605 typed listing rows; typed rows were linked to raw evidence. The apparent 99.9% review rate is inflated by the `grounding_backfill_20260830` marker on 50,280 rows.
- Findings: The dominant observed families are title-evidence mismatch, missing BHK/price/building/locality evidence, dropped item-scoped BHK, inconsistent price-unit normalization, and sibling leakage risk in mixed or multi-listing broadcasts. Only 5,479 typed rows had a persisted `ai_extraction.source_slice`, exposing an evidence-storage contract gap.
- Verification: Read-only Supabase aggregate queries and redacted raw-vs-saved samples were used. `python3 -m py_compile scripts/build_extraction_replay_corpus.py`, `pytest -q tests/test_extraction_replay_corpus.py` (3 passed), and scoped `git diff --check` passed. The live management-token path generated 240 cases from 456 linked raw messages and reported `read_only: true`. Independent task-verifier second pass: PASS for the audit and read-only corpus-builder deliverable.
- Deployment/push: No production data or service was changed; no redeployment is required for this documentation-only audit. Push status is pending this report commit.
- Limitations/failures: The local REST-key path is not usable with the management token, so the builder now supports the verified Supabase management SQL path. The audit still does not re-run all 831,213 messages or provide field-level precision/recall. It does not implement the recommended P0/P1 fixes.
- Next action: Review the generated 240-case manifest, annotate expected fields for a stratified subset, then add the explicit replay/evaluation runner and regression fixtures.
- Independent verifier verdict: PASS — the requested read-only audit and safe corpus-builder are complete and evidence-backed; live manifest generation and code hardening are explicitly pending.

## 2026-09-10 — Approved bounded extraction replay

- Requested outcome: Re-run the approved 240-case corpus through the production extraction path.
- Changes: Added `scripts/replay_extraction_manifest.py`. It validates every manifest source hash and tenant-linked raw ID before applying an exact, bounded queue reset; it never deletes typed rows or resets unrelated backlog rows.
- Verification: Dry-run passed for 240 cases / 228 unique raw messages across 2 tenants, with all source hashes verified. The approved apply reset exactly 228 raw rows. The extraction worker heartbeat is healthy, but the selected historical rows remain pending behind its existing backlog; replay completion is not yet claimed.
- Deployment/push: No service code deployment required. Runner and documentation changes are being pushed. Production database was intentionally changed only by the approved 228-row queue reset.
- Limitations/failures: The worker is configured with 2 backlog slots and has not yet picked these selected rows. No field-level accuracy result exists until processing completes and the new typed outputs are compared against reviewed expectations.
- Next action: Prioritize or execute these exact raw IDs through a dedicated replay lane, then compare post-replay rows against the manifest and report changed fields/flags.
- Independent verifier verdict: PARTIAL — source validation and bounded reset passed; production replay processing and post-replay evaluation remain pending.

## 2026-09-10 — WhatsApp PropAI operator fast path

- Requested outcome: Make PropAI's WhatsApp self-chat feel like a capable assistant that quickly reads captured group activity, returns grounded property options, and acknowledges messages as read.
- Outcome: Partial pending ingestor build/deployment and live WhatsApp verification. Source changes are implemented: concrete property searches now use a deterministic live-market fast path; group-history questions can read tenant-scoped raw WhatsApp evidence directly; self-chat messages are marked read immediately; and self-chat turns are serialized per WhatsApp connection to preserve reply order.
- Changes: Updated `routers/self_chat.py`, `services/whatsmeow-ingestor/main.go`, and `architecture.md`. No new inventory source or LLM provider was introduced. Ambiguous questions and workspace actions still use the existing LangGraph path.
- Verification: `python3 -m py_compile routers/self_chat.py` passed; deterministic parser smoke test for `3 BHK rentals in Bandra West` returned the expected rent/BHK/locality filters; scoped `git diff --check` passed. The repository has no Go compiler (`gofmt: command not found`), so ingestor compilation could not be run locally. No production deployment or WhatsApp round-trip was performed in this task.
- Deployment/push: Commit and push pending while this entry is finalized. Coolify services requiring redeployment: `api` and `ingestor`.
- Limitations/failures: The read acknowledgement is WhatsApp's native MarkRead/blue-tick signal; it is not a custom eye icon. The deterministic group lookup returns source snippets, while richer interpretation remains on LangGraph. Live verification must confirm the production database adapter supports the tenant-scoped raw-message query and that rapid self-chat messages arrive in order.
- Next action: Commit/push, redeploy `api` and `ingestor`, then send one market query and two rapid self-chat messages to verify read acknowledgement, one response per turn, grounded options, and ordered delivery.
- Independent verifier verdict: PARTIAL — Python path and diff checks pass; Go compilation, production deployment, and live WhatsApp acceptance tests remain unverified.

## Non-negotiable rule

Before an agent declares a task complete, it must append a report here. This
applies to coding, debugging, UI, data, infrastructure, deployment, and
documentation tasks. A report must be written even when the task is blocked or
the result is a failure.

The report must be honest and specific. Do not describe a partial safeguard as
a complete solution. If live verification was unavailable, say so explicitly.

## 2026-09-10 — Public locality coverage and inventory intelligence

- Requested outcome: Show complete locality coverage and trustworthy counts on `www.propai.live/localities`, with client-facing market intelligence instead of a small generic listing directory.
- Outcome: Partial pending public-site redeployment. The production migration is applied and verified; the site has not yet been redeployed in this task.
- Changes: Added `get_public_locality_inventory` server-only aggregate migration; added canonical locality/registry aggregation with listing-record, transaction, BHK, 24-hour activity, unmapped-record, and conservative comparable-price metrics; removed the public `needs_review = false` exclusion and heuristic cross-record deduplication from locality detail reads; included locality-reference aliases; redesigned the locality directory around coverage and explainable intelligence; updated `architecture.md`.
- Verification: `pnpm run build` in `apps/www` passed on Next.js 16.2.9; Impeccable detector returned `[]`; scoped `git diff --check` passed. Live read-only query found 54,228 recent public projection records versus 61 with `needs_review = false`, confirming the undercount mechanism. Migration application returned HTTP 201. Production verification returned `function_exists=true`, `groups=1168`, `records=33737`, and `registry=155`. The public legacy Supabase key returned 401 because legacy keys were disabled; the server key was usable. The new `tsx` test could not run because `tsx` is not installed.
- Deployment/push: Commit `721253bf` pushed to `origin/main`; this report-only follow-up is pending push. Coolify service requiring redeployment: `propai-lab:main` (`www.propai.live`). No deployment was performed.
- Limitations/failures: The database migration is live, but the public site has not yet been redeployed, so the live locality page is not yet consuming the new RPC. Price ranges intentionally omit PSF, ambiguous, and source-conflicting values.
- Next action: Redeploy `propai-lab:main`, then verify `/localities` and one locality detail page against the production RPC output. Install or use the repository’s supported TypeScript test runner and run `apps/www/test/locality-inventory.test.ts`.
- Independent verifier verdict: PARTIAL until the public-site redeployment and live page verification are complete.

## Required report format

```md
## YYYY-MM-DD — Short task name

- Requested outcome: What the user asked for.
- Outcome: Complete, partial, blocked, or failed; state what actually happened.
- Changes: Files, migrations, services, or configuration changed.
- Verification: Tests, queries, screenshots, logs, or deployment checks run.
- Deployment/push: Commit SHA, remote push status, and Coolify services needing redeployment.
- Limitations/failures: What remains uncertain, broken, or incomplete.
- Next action: The concrete follow-up, or “None”.
```

## 2026-09-04 — Mandatory completion reporting

- Requested outcome: Create a document that every agent must update after every completed task, with no session allowed to skip it.
- Outcome: Complete in the repository. The rule is now part of the root `AGENTS.md`, and this document provides the required format and first entry.
- Changes: Added hard rule 13 to `AGENTS.md`; created `docs/TASK_COMPLETION_REPORT.md`.
- Verification: Confirmed both files exist and contain the mandatory rule, required fields, and this entry.
- Deployment/push: Pushed to `origin/redesign/propai-product-interface` in commit `7435be51`. No Coolify redeployment is required for this documentation-only change.
- Limitations/failures: Agents must still follow the repository instruction; this file cannot mechanically prevent an agent from ignoring instructions.
- Next action: None.

## Verification requirement

Every future entry must include the independent `task-verifier` verdict and
evidence before the task can be called complete. The verifier is a separate
review pass, not a restatement of the implementer's summary.

## 2026-09-09 — Technical debt register

- Requested outcome: Create a document to track PropAI technical debt so it can be addressed one item at a time.
- Outcome: Complete as a repository documentation change. Added a ranked, evidence-backed technical debt register with P0/P1/P2 priorities, acceptance criteria, execution order, intentional non-debt constraints, and a task template.
- Changes: Added `docs/TECHNICAL_DEBT.md`. No application code, database schema, production data, or deployment configuration changed.
- Verification: Read the repository entry instructions and source audit documents; cross-checked the register against `docs/PROPai_DATA_QUALITY_AUDIT_2026-08-16.md`, `docs/PROPai_FRESH_OPERATIONAL_AUDIT_2026-09-02.md`, `architecture.md`, service Dockerfiles, worker files, package manifests, and the supplied Pipeline Health screenshots. `git diff --check` passed. Independent task-verifier verdict: PASS; the requested document exists, is actionable, cites repository evidence, and separates intentional constraints from debt.
- Deployment/push: Documentation-only; no Coolify redeployment is required. Commit and push status will be recorded after the commit is created.
- Limitations/failures: Production counts in the register are dated audit snapshots, not current live queries. They must be remeasured when each debt item is started.
- Next action: Start with TD-003, then TD-001, unless a new production incident changes the priority.

## Pending — end-to-end platform audit

The following work is explicitly pending and must not be described as
complete:

- Inventory the code and services currently deployed in Coolify.
- Verify `langgraph` and `langgraph-checkpoint-redis` inside the running API/agent container.
- Verify `LANGGRAPH_REDIS_URL` and Redis checkpointing with a real resumed agent session.
- Measure dedupe stops from September 1 through the current date using live evidence.
- Reconcile extraction/LLM usage against the number of parsed listings and requirements.
- Identify every incomplete, failed, or misleading implementation and report it plainly.

No new feature work should be treated as complete until this audit has a
documented PASS verdict with production evidence.

## 2026-09-09 — Preserve JODI listings and suppress Gurukrupa sources

- Requested outcome: Correct the Anand 268 building/listing presentation where a source explicitly says `3 BHK + 3 BHK (JODI)`, and prevent Gurukrupa plus its associated phone identities from entering extraction.
- Outcome: Complete for the identified live rows and forward extraction path. The two live Anand 268 ₹14 Cr rows now carry the explicit JODI configuration/title. Rustomjee Paramount’s stored building/locality identity was checked and is consistent with the source.
- Changes: Added source-grounded combination detection/title generation in `extraction.py` and `routers/infra.py`; added phone-aware blocking in `extraction_worker.py`; added repeatable migration `supabase/migrations/20260909100000_expand_gurukrupa_source_block.sql`; added regression tests. Production source-block aliases were updated to include 8 observed Gurukrupa sender-phone identities (12 aliases total), and the two Anand 268 rows were repaired directly.
- Verification: `pytest -q tests/test_system_source_blocks.py tests/test_combination_source_title.py tests/test_p0_title_and_evidence.py` passed: 33 passed. Production query confirmed the pre-repair Anand 268 rows had no combination metadata; production update returned both rows with `3 BHK + 3 BHK (JODI)`. Coolify worker logs after deployment showed no NVIDIA/provider failures and continued pre-extraction suppression. Independent task-verifier verdict: PASS for the requested acceptance conditions.
- Deployment/push: Commit `e08ef87e` pushed to `origin/main`. Coolify `extraction-worker` deployed and finished successfully from that commit. No API or public-site redeploy is required for this worker/data fix.
- Limitations/failures: Historical rows other than the two identified Anand 268 ₹14 Cr rows are not globally rewritten; future source slices with explicit JODI syntax are handled deterministically. The migration remains version-controlled for repeatable environments; production aliases and the identified data repair were applied directly.
- Next action: None.

## 2026-09-04 — Task verifier admin health endpoint

- Requested outcome: Add `GET /api/admin/task-verifier/health`, restricted to authenticated Super Admins, with a stable health response and authorization tests.
- Outcome: Complete.
- Changes: Added the read-only endpoint in `routers/admin.py`; added `tests/test_task_verifier_health.py` covering the HTTP 200 response, required fields, ISO timestamp, and HTTP 403 for non-admin users.
- Verification: The initial full-app test attempt failed during collection because this environment does not have the optional `langgraph` dependency; the first synchronous `TestClient` version also hung during teardown. The test was narrowed to a minimal FastAPI app using the production admin router and direct ASGI requests. The final `python3 -m pytest -q tests/test_task_verifier_health.py` run passed: 1 passed, 1 warning. `python3 -m py_compile routers/admin.py tests/test_task_verifier_health.py` passed, and `git diff --check` passed. Independent task-verifier verdict: PASS; all requested acceptance conditions were checked against the final route and ASGI test path.
- Deployment/push: Implementation committed as `2a512601`. No Coolify deployment was requested or performed.
- Limitations/failures: The repository test environment emits an existing JWKS initialization warning; it does not affect this endpoint test. No production-data changes were made.
- Next action: Push the commit to the configured Git remote.

## 2026-09-04 — Independent task verifier

- Requested outcome: Build a Codex sub-agent/second pass that verifies every task is fully implemented.
- Outcome: Complete as a repository-local verification skill and mandatory agent rule. This is a review agent, not an autonomous production mutator.
- Changes: Added `.agents/skills/task-verifier/SKILL.md`; added hard rule 14 to `AGENTS.md`; documented the requirement here.
- Verification: Ran the skill creator validator: `Skill is valid!`; ran `git diff --check` successfully. The verifier requires acceptance-condition evidence, tests/live checks where relevant, and a PASS/PARTIAL/FAILED verdict.
- Independent verifier verdict: PASS. All requested repository-level acceptance conditions are present and validated; the remaining limitation is explicitly documented.
- Deployment/push: Documentation/skill files only; no Coolify redeployment required. Commit and push pending while this entry is finalized.
- Limitations/failures: Codex does not expose a separate autonomous sub-agent runner in this workspace, so this is enforced as a dedicated second-pass skill/protocol used by the primary agent.
- Next action: Commit and push these changes, staging only `AGENTS.md`, `docs/TASK_COMPLETION_REPORT.md`, and `.agents/skills/task-verifier/SKILL.md`.

## 2026-09-04 — Verifier test correction

- Requested outcome: Test whether a separate Codex instance would reject an incomplete task.
- Outcome: **FAILED**. The test run visibly reported a failing pytest invocation, but the final handoff still claimed `PASS`.
- Evidence: The separate session screenshot showed `FAILED tests/test_task_verifier_health.py::...` followed by `Independent task-verifier: PASS`. A later rerun passed, but that did not erase the earlier failure or justify the original PASS verdict.
- Root cause: The current verifier is instruction-based and can be overridden or misreported by the same agent; it is not yet a mechanically enforced independent reviewer.
- Changes: Corrected this report so the failed verification is recorded honestly. No application code or production data was changed in this correction.
- Verification: Re-ran `python3 -m pytest -q tests/test_task_verifier_health.py`; the current worktree passed 1 test. This is recorded separately from the failed run.
- Deployment/push: Documentation-only correction; no Coolify redeployment required.
- Next action: Add a mechanical gate that prevents a PASS verdict when any required task test has failed, and use a genuinely separate Codex review process where available.

## 2026-09-04 — Fix dedupe gate evidence 503

- Requested outcome: Investigate and fix the 503 shown on the Super Admin Dedupe Gate Evidence page.
- Outcome: Complete for the identified application regression. The endpoint now applies the indexed repeat-observation predicate to both its feed and current exact-count queries, avoiding broad `raw_messages` scans.
- Changes: Updated `routers/admin.py`; added `tests/test_admin_dedupe_gate.py` to verify the generated PostgREST filters.
- Verification: Live Coolify API logs showed Supabase statement timeouts under dashboard load. Targeted dedupe, message-identity, extraction-dedup, and extraction-quality tests ran with 62 passed and 1 unrelated pre-existing PSF-repair failure; the focused regression test passed (`1 passed`). `compileall` and `git diff --check` passed. A broader extraction test collection is blocked by the environment's missing optional `langgraph` package. Independent task-verifier verdict: PASS for the requested dedupe endpoint fix, with the unrelated test limitations recorded above.
- Deployment/push: Committed as `55b52e4f` and pushed to `origin/redesign/propai-product-interface`. No production data or migration was changed. Coolify `api` needs redeployment to run the fix; `propai-lab:main-app` does not require a code redeploy unless its proxy bundle is separately stale.
- Limitations/failures: Production endpoint retest could not be performed from this sandbox because direct Supabase network access was unavailable and the authenticated browser session was not controlled. The current API logs confirm the timeout pattern, while the code/test path confirms the corrected predicates.
- Next action: Redeploy the Coolify `api` service when approved, then retest the authenticated page.

## 2026-09-04 — Remove legacy dedupe count timeout

- Requested outcome: Resolve the remaining production 503 after the indexed dedupe predicate was deployed.
- Outcome: Complete in source; the endpoint no longer blocks current gate evidence on the optional legacy-link exact count that timed out in production.
- Changes: Updated `routers/admin.py` to return the current exact gate total and evidence rows without querying the unbounded legacy count. The legacy count was not consumed by the current frontend.
- Verification: Production Coolify logs showed the corrected feed and current count path succeeding, followed by timeout at the legacy query. `pytest -q tests/test_admin_dedupe_gate.py` passed (`1 passed`); `compileall` and `git diff --check` passed. Independent task-verifier verdict: PASS for the requested endpoint fix.
- Deployment/push: Follow-up committed as `b26c30c5` and merged/pushed to `origin/main` in `6827b3ce`. Coolify `api` requires another redeploy after this source change; no migration or production data change was made.
- Limitations/failures: The production endpoint cannot be retested until the new API image is deployed. The separate extraction-progress RPC continues to time out but is handled as a degraded 200 response and is unrelated to this endpoint.
- Next action: Manually redeploy Coolify `api`, then capture the raw authenticated endpoint response.

## 2026-09-04 — Workspace theme and contrast system

- Requested outcome: Apply a maintainable brand-green button/text treatment and readable tab states across the authenticated app, including shared screens, controls, and dialogs, without changing data or backend logic.
- Outcome: Complete for the local frontend implementation. Canonical `brand-green`, hover, soft-border, and on-green tokens now drive the shared Button primitive, workspace tab strip, legacy primary-action utilities, text/link contrast overrides, and Radix dialog portal controls.
- Changes: `frontend/src/styles/unified-tokens.css`, `packages/design-tokens/tokens.css`, `frontend/src/app/globals.css`, `frontend/src/app/zone-contract.css`, `frontend/src/components/ui/button.tsx`, and `frontend/src/lib/design-tokens.ts`.
- Verification: WCAG contrast calculations: `#3A5A40` on `#FFFEFA` = `7.66:1`; `#344E41` on `#DAD7CD` = `6.31:1`; `#3A5A40` on `#DAD7CD` = `5.37:1`; `#344E41` on `#FFFFFF` = `9.08:1`. `npm run lint` completed with 0 errors and 473 existing warnings. `npm run design:check` passed. Placeholder-env `npm run build` passed and generated all 74 routes. `git diff --check` passed. Impeccable detector found only the existing unrelated bounce easing token warning. Independent task-verifier verdict: PASS; the staged diff was checked for scope and the shared shell path covers the named workspace surfaces, tab states, and portal dialogs.
- Deployment/push: No deployment performed. This frontend change must be pushed and then the Coolify `propai-lab:main-app` service requires a manual redeploy; `api` is not changed.
- Limitations/failures: No live production screenshot was taken in this pass. The tab-bar fix is specifically: forest strip background; readable cream inactive labels; token-backed brand-green hover and active backgrounds; cream active text, border, focus stripe, close icon, and SVG inheritance. The existing dirty worktree contains unrelated user changes that were not staged.
- Next action: Commit and push this frontend/theme change, then manually redeploy `propai-lab:main-app` and visually confirm the authenticated screens.

## 2026-09-04 — Follow-up green action foreground correction

- Requested outcome: Correct the remaining dark foreground text on green action buttons visible across the deployed CRM and Market Inbox screens.
- Outcome: Complete in source. Added a final shared selector for arbitrary Tailwind background utilities and the named Market Inbox WhatsApp action, forcing the canonical brand-green background/hover pair with cream foreground text.
- Changes: `frontend/src/app/zone-contract.css` and this report only; no data, query, or backend logic changed.
- Verification: Frontend production build passed with placeholder public Supabase values and all 74 routes generated; `git diff --check` passed. Coolify API inspection confirmed `propai-lab:main-app` currently deploys branch `fix/langgraph-ops-redis-production`, not `main`.
- Independent task-verifier verdict: PARTIAL until the main-app deployment source is repointed to `main` or the fix is merged into the configured branch and redeployed; local source implementation is verified, but the live visual state cannot be attributed to this commit while Coolify deploys the other branch.
- Deployment/push: Pending commit/push and redeployment from the correct source branch. The current Coolify application is `y18kprfw29mu6wclzgpgfrvv` (`propai-lab:main-app`).
- Limitations/failures: The supplied screenshots are valid evidence that production is still using the wrong source revision; no further page-specific CSS fork will be added.
- Next action: Push the correction to `main`, then redeploy `propai-lab:main-app` from `main` and recheck CRM, Market Inbox, and Pipeline Health.

## 2026-09-04 — Final surface-contrast cascade correction

- Requested outcome: Ensure the app-wide rule is applied in the actual cascade so green surfaces always use light foreground text and paper surfaces use dark foreground text.
- Outcome: Added high-specificity shared overrides for active workspace tabs, Market Inbox WhatsApp actions, arbitrary green Tailwind buttons, and standard colored action buttons. This remains CSS-only and app-wide.
- Verification: Local frontend build passed with placeholder public Supabase values and all 74 routes generated; `git diff --check` passed. Live screenshots were used as regression evidence: prior deployed output showed the cascade gap.
- Deployment/push: Coolify `propai-lab:main-app` is now configured for `main`; commit and redeploy are pending.
- Limitation: Live visual confirmation requires the next Coolify deployment from `main`.

## 2026-09-04 — Market Inbox specificity correction

- Requested outcome: Fix the remaining orange/dark-text action buttons visible after the `main` deployment.
- Root cause: An older selector targeting `.market-inbox-card[data-propai-market-card="true"] .market-whatsapp-action` had greater specificity and explicitly set orange background/white text, overriding the generic green contract.
- Change: Replaced that legacy declaration and its hover state with `--brand-green`, `--brand-green-hover`, and `--brand-on-green` in `frontend/src/app/zone-contract.css`.
- Verification: `git diff --check` passed. Independent second-pass review: PASS for the source cascade; the exact higher-specificity selector now uses the canonical tokens. Live confirmation remains pending the next deployment.
- Deployment/push: Pending commit/push and Coolify redeploy from `main`.

## 2026-09-04 — Landing and auth modal contrast correction

- Requested outcome: Extend the same contrast contract to the app home/landing page and account-access modal, not only data-workspace screens.
- Change: Updated the shared frontend `.broker-button` and auth-tab styles so green surfaces use `--brand-on-green`; mirrored the canonical action tokens into `apps/www` and updated its shared Button/public CTA rules.
- Verification: Frontend build passed with all 74 routes generated. Public-site build completed TypeScript and static generation stages; it emitted the existing production configuration warning about `SUPABASE_SERVICE_KEY` and no code error was reported. `git diff --check` passed.
- Independent task-verifier verdict: PARTIAL until both affected Coolify services are redeployed and the live landing/auth modal is visually rechecked; source coverage is complete for the observed home-page path.
- Deployment/push: Pending commit/push. Authenticated app service: `propai-lab:main-app`; public site service: `propai-lab:main`.
- Next action: Push these changes, redeploy both services from `main`, then verify the landing CTA and auth modal foreground/background pairing.

## 2026-09-04 — Shared Radix tab primitive correction

- Requested outcome: Fix the remaining dark text on active Asset/Deal/CRM tabs visible after the Market Inbox action correction.
- Root cause: `frontend/src/components/ui/tabs.tsx` still used legacy `--monsoon-teal`/`--mist` active-state utilities and was not using the canonical workspace action pair.
- Change: Updated the shared `TabsTrigger` active, hover, and focus classes to use `--brand-green`, `--brand-on-green`, and `--brand-green-soft`; no data logic changed.
- Verification: Frontend build passed all 74 routes; `git diff --check` passed. Independent second-pass verdict: PASS for the source-level tab primitive and action cascade; live verification remains pending deployment.
- Deployment/push: Pending commit/push and redeploy of `propai-lab:main-app` from `main`.

## 2026-09-04 — Needs-review logic correction

- Requested outcome: Stop unconditional commercial `needs_review` defaults and prevent the historical grounding marker from suppressing top-level high-confidence rows, without changing the existing backlog.
- Outcome: Corrected the historical typed insert expressions, added the active typed-write guard, and made grounding disagreements visible through `grounding_confidence_disagreement` without applying a new review gate to high-confidence rows.
- Changes: `storage/supabase.py`, `supabase/migrations/20260803020000_typed_extraction_schemas.sql`, `supabase/migrations/20260830100000_flag_low_confidence_grounding_rows.sql`, and `docs/REMEDIATION_PLAN.md`.
- Verification: Python compilation and focused guard assertions passed. The targeted Phase 2 static verification passed. Existing focused tests had 44 passes and 10 unrelated pre-existing failures; the full suite remains affected by missing `langgraph` during collection. Independent scope verification passed.
- Deployment/push: Commit `62db514f` was pushed to the development branch and published on production `main` as `78f19710`. The first API build attempt used an older revision and was discarded. Successful Coolify deployments: API `ltab6d3zsorxq42horiv8xow`; extraction worker `ybcyy2k4isqe62s9kaicktbh`. Both finished successfully and services remained running.
- Data impact: No production migration or backfill was run. Existing rows changed: `0`; existing `needs_review` backlog changed: `0`.
- Limitations: Historical migration edits affect fresh/rebuilt databases; the active API/worker guard makes the high-confidence protection effective for future typed writes. Existing backlog handling remains deferred. API logs still show an unrelated extraction-progress RPC timeout handled as a degraded 200 response.
- Next action: Review and explicitly decide whether/when to address the existing historical `needs_review` backlog; do not infer a cleanup from this logic deployment.

## 2026-09-04 — Component-level contrast and price overflow correction

- Requested outcome: Apply the light-background/dark-text and green-background/light-text rule at the shared component boundary, and keep Market Inbox price labels/values visible inside cards.
- Change: Updated `frontend/src/app/zone-contract.css` with high-specificity token-backed rules for legacy transparent buttons, Radix active tabs, and the reusable Market Inbox card price grid/value. No data, query, or backend logic changed.
- Verification: `git diff --check` passed. Elevated frontend production build passed: `Compiled successfully`; all 74 routes generated. Independent task-verifier verdict: PARTIAL — source-level acceptance conditions pass, but live screenshots still require deployment from current `main` and a browser retest.
- Deployment/push: Not yet pushed for this follow-up. `propai-lab:main-app` must be manually redeployed from `main` after push; no automatic redeploy is assumed.
- Limitations: The first sandbox build attempt was blocked by the environment (`Operation not permitted` while Turbopack tried to bind a process); the elevated retry passed. Live visual confirmation is still pending.
- Next action: Commit/push the CSS follow-up to the configured `main` branch, manually redeploy `propai-lab:main-app`, then retest Inbox, CRM, Pipeline Health, landing, and auth modal screenshots.

## 2026-09-04 — Success badge foreground correction

- Requested outcome: Remove the remaining dark text on filled green status components visible in the redeployed Market Inbox.
- Evidence: User screenshot after `ef776c29` showed `Source checked` rendered dark on a filled green badge while price wrapping and WhatsApp button contrast were corrected.
- Change: Added token-backed component rules for `.propai-status-badge-verified` and `.propai-status-badge-fresh` in `frontend/src/app/zone-contract.css`, including descendant/icon foregrounds.
- Verification: `git diff --check` pending commit; independent second-pass verdict: PARTIAL until the new commit is deployed and the live badge/tab surfaces are rechecked.
- Deployment/push: This follow-up must be pushed to `main`; manual Coolify redeploy of `propai-lab:main-app` is required afterward.

## 2026-09-04 — Full visual system reset to skeleton primitives

- Requested outcome: Remove the existing custom visual design while retaining page structure, routes, data behavior, and interaction behavior; leave a minimal shadcn-style component skeleton for a fresh color pass.
- Change: Replaced the large legacy visual cascades with compact structural CSS and neutral shared tokens in `frontend/src/app/globals.css`, `frontend/src/app/zone-contract.css`, `frontend/src/styles/unified-tokens.css`, `apps/www/src/app/globals.css`, `apps/www/src/app/public-theme.css`, and `apps/www/src/styles/unified-tokens.css`.
- Preserved: No page JSX, API, database, extraction, search, or backend files were changed for this reset.
- Verification: Authenticated frontend build passed with all 74 routes. Public website build passed with all 10 static/dynamic routes; it emitted only the existing missing Supabase environment warning. `git diff --check` passed for all six reset files.
- Independent task-verifier verdict: PARTIAL — source/build acceptance passes, but visual browser review and deployment remain pending.
- Deployment/push: Committed as `da2fcd52` on the development branch and promoted to `main` as `9c26f6e5`. Coolify services `propai-lab:main-app` and `propai-lab:main` require manual redeployment; no deployment was triggered.
- Limitation: This intentionally removes the prior visual identity; the next step is to apply the user-approved color/contrast map to the shared primitives only.

## 2026-09-04 — Apply authoritative PropAI light-only token matrix

- Requested outcome: Replace the temporary neutral skeleton palette with the supplied authoritative PropAI tokens and component state matrix.
- Change: Updated `packages/design-tokens/tokens.css` as the source of truth and ran `node scripts/sync-design-tokens.mjs`. Updated shared Button, Tabs, and Badge primitives plus shell/workspace tab states to consume the light-only semantic tokens. No dark navigation/content theme remains.
- Token matrix applied: workspace `#DAD7CD`, card `#F8F7F2`, primary text `#3A5A40`, muted text `#596B58`, brand action `#588157` with `#DAD7CD` foreground, success `#3A5A40`, warning `#A66B16`, error `#A33D36`, info `#2F5F75`, and 4px geometry.
- Verification: `npm run design:check` passed. Authenticated build passed with 74 routes. Public build passed with 10 routes; only the existing missing Supabase environment warning was emitted. `git diff --check` passed.
- Independent task-verifier verdict: PARTIAL until visual browser review and production redeployment confirm all named screens.
- Deployment/push: Committed as `71229453` on the development branch and promoted to `main` as `29dd25c0`. Coolify `propai-lab:main-app` and `propai-lab:main` require manual redeployment; no deployment was triggered.

## 2026-09-04 — Inbox component refinement from live screenshot

- Requested outcome: Improve the deployed Inbox surface after the token reset: make Refresh visible, strengthen secondary WhatsApp actions, remove repeated locality Details labels, and move Source checked below the listing content as a compact evidence chip.
- Change: Updated shared inbox structural CSS and the canonical UI font stack; status placement, legacy outline-control visibility, locality detail suppression, and WhatsApp action sizing are component-level rules. No data or backend logic changed.
- Verification: Authenticated build passed with 74 routes. Public build passed with 10 routes. `git diff --check` passed. Independent task-verifier verdict: PARTIAL until the new production deployment is visually reviewed.
- Deployment/push: Pending commit/push and manual Coolify redeploy of `propai-lab:main-app` and `propai-lab:main`.

## 2026-09-04 — Restore workspace dropdown geometry

- Requested outcome: Prevent the module/overflow tab dropdown from expanding the workspace tab strip and obscuring tab labels.
- Evidence: Live screenshot showed the module catalogue rendered in normal flow as a large faded block above the page content.
- Change: Restored shared structural geometry for `.workspace-module-menu` and `.workspace-tab-menu`, fixed the tab strip to 44px, and moved horizontal scrolling to the inner tab row. No data or backend logic changed.
- Verification: `git diff --check` passed. Frontend build verification pending this final CSS-only change; independent task-verifier verdict: PARTIAL until deployment and screenshot review.
- Deployment/push: Pending commit/push and manual Coolify redeploy of `propai-lab:main-app`.

## 2026-09-04 — Restore public homepage composition structure

- Requested outcome: Restore the public site’s layout structure after the skeleton reset made homepage sections render as a flat text stack.
- Evidence: Live `www.propai.live` screenshot showed `mp-*` hero, pulse, suggestion, stat, and section layouts missing their grid/spacing structure.
- Change: Restored the public composition/layout rules in `apps/www/src/app/public-theme.css`, removed its obsolete dark-mode block, and rebound public semantic aliases to the authoritative light-only tokens. No page/data/SEO logic changed.
- Verification: Public build passed with all 10 routes. `git diff --check` passed. Independent task-verifier verdict: PARTIAL until the public deployment is visually rechecked.
- Deployment/push: Pending commit/push and manual Coolify redeploy of `propai-lab:main`.

## 2026-09-04 — Phase 3 locality evidence design, dry run, and migration draft

- Requested outcome: Design and preview a non-guessing path from verified Google Places building evidence to canonical locality fields, then prepare the generic seed/backfill migration after approval.
- Outcome: The design, live dry run, and approved production migration are complete. Migration `20260904123000_promote_places_building_localities.sql` covered all eight typed tables, added collision-checked Bandra vocabulary, promoted unique candidates, and flagged ambiguity without changing `needs_review`.
- Changes: `supabase/migrations/20260904123000_promote_places_building_localities.sql`, `architecture.md`, `docs/REMEDIATION_PLAN.md`, and this report. Production recorded 1,618 locality promotions and 748 ambiguity/no-reference validation-flag additions.
- Verification: Production migration ledger records `20260904123000` applied. The migration run recorded 2,366 eligible rows: 1,618 deterministic, 237 ambiguous-parent, 174 ambiguous-child, and 337 no-reference. Post-run verification across all eight tables found 13,378 matched rows, all with non-null locality IDs, and no matched-row overwrite path. `git diff --check` passed. Independent second-pass verdict: PASS for the approved Phase 3 migration scope.
- Deployment/push: No application redeployment was required. Database migration was applied through the authenticated Supabase CLI using an isolated ledger containing only the approved migration; repository commit/push is pending.
- Limitations: The earlier 1,224-row figure did not reproduce under the current all-eight-table/provider-address scope; the current run scope was 2,366. Ambiguous and no-reference rows remain unresolved and are represented by validation flags; Phase 4 wiring audit regeneration was not started.
- Next action: Commit and push the migration/documentation changes, then proceed to Phase 4 wiring-audit regeneration.

## 2026-09-04 — Locality remediation handoff

- Requested outcome: Create a durable handoff of completed locality work,
  pending resolver work, the no-regex design decision, and the separate raw
  message retention decision.
- Changes: Added `docs/LOCALITY_REMEDIATION_HANDOFF.md`. No production data,
  schema, resolver, extraction, or website code was changed.
- Verification: Reviewed `docs/REMEDIATION_PLAN.md`, relevant resolver,
  extraction, storage, website, and retention references. `git diff --check`
  passed for the handoff and report changes.
- Independent task-verifier verdict: PASS for the requested documentation
  handoff; implementation of the new resolver remains explicitly pending.
- Deployment/push: No deployment. Commit and push are pending.
- Limitations: The historical raw-message recovery preview is directional and
  incomplete; no historical repairs or raw-message expiry/deletion occurred.
- Next action: Implement and test the structured, exact-match resolver, then
  show a complete read-only eight-table preview before requesting any data
  write approval.

## 2026-09-05 — Structured locality resolver implementation

- Requested outcome: Continue locality remediation with a resolver for future
  LLM-extracted locality data, without regex-based extraction or production
  data changes.
- Changes: `registry/locality_resolver.py` now performs Unicode/case/separator
  normalization and exact gazetteer/alias lookup, returning explicit matched,
  missing, unmatched, and ambiguous decisions with `locality_id` when unique.
  `storage/base.py` and `storage/supabase.py` carry and persist locality
  identity/status fields; the typed observation path invokes the resolver
  before new writes. `backfill_localities.py` uses non-regex URL handling.
  Added focused resolver tests and updated `architecture.md`,
  `docs/REMEDIATION_PLAN.md`, and the locality handoff.
- Verification: 9 focused resolver tests passed; Python compilation and
  `git diff --check` passed. Broader extraction tests were blocked during
  collection by the existing missing `langgraph` dependency.
- Independent task-verifier verdict: PARTIAL — the pure resolver and local
  persistence wiring are implemented, but integration coverage and production
  deployment are pending.
- Deployment/push: No production deployment or data/schema migration. Commit
  and push are pending.
- Limitations: Historical rows are unchanged. The full eight-table recovery
  preview has not been completed, and no raw-message expiry/deletion occurred.
- Next action: Add integration tests around typed observation persistence,
  review the exact diff, then obtain approval before deployment and any
  historical data write.

## 2026-09-05 — Restore local LangGraph test dependency

- Requested outcome: Add the missing `langgraph` dependency so the blocked
  tests can run.
- Finding: `langgraph==0.6.8` was already declared in `requirements.txt`; no
  repository dependency edit was necessary.
- Change: Installed the declared version and its dependencies into the
  isolated temporary environment `/tmp/propai-lab-langgraph-venv`. System
  Python and production were not modified.
- Verification: `from langgraph.graph import END, START, StateGraph` imports
  successfully. The targeted extraction tests changed from collection failure
  to 3 passed and 1 failed; the remaining failure is an unrelated existing
  source-boundary assertion in `test_same_locality_requirements_use_distinct_configuration_evidence`.
- Independent task-verifier verdict: PARTIAL — the missing import is fixed in
  the isolated environment, but the targeted test selection is not fully green.
- Deployment/push: No deployment. No `requirements.txt` diff was made.
- Next action: Decide whether to repair the unrelated source-boundary test
  separately; use the temporary environment for continued local verification.

## 2026-09-05 — Dense requirement source-boundary repair

- Requested outcome: Repair the extraction test failure caused by adding the
  missing LangGraph test dependency.
- Change: Updated `_slice_blocks_for_ai_items` in `extraction.py` so when the
  document segmenter returns no semantic blocks for dense numbered
  requirements, exclusive non-empty lines are used when they cover the
  extracted items. This prevents the full broadcast being assigned to every
  item and cross-wiring BHK/budget/locality evidence.
- Verification: The focused extraction/locality selection passed 9 tests. A
  full run of `tests/test_extraction_pipeline.py` and
  `tests/test_locality_backfill_apply.py` ran under the Python 3.12 environment
  with declared requirements and reported 54 passed, 28 failed. The remaining
  failures span unrelated existing pricing, segmenter, worker-fixture, and
  legacy backfill tests; they are not hidden by this change.
- Independent task-verifier verdict: PARTIAL — the reported source-boundary
  regression is fixed, but the broader existing test files remain unhealthy.
- Deployment/push: No deployment. Local code changes remain pending review.
- Limitations: This change does not repair the unrelated 28 failures or alter
  production data. The locality resolver still requires integration review
  before deployment.
- Next action: Review the resolver/storage diff and isolate the remaining
  baseline test failures before any production deployment.

## 2026-09-05 — Locality persistence integration coverage

- Requested outcome: Continue the locality resolver implementation and verify
  the structured decision at the typed persistence boundary.
- Change: Added `_apply_structured_locality_decision` in `storage/supabase.py`
  and focused tests in `tests/test_locality_persistence.py`. Unique locality
  matches receive canonical fields and `locality_id`; ambiguous matches remain
  unresolved with `locality_resolution_ambiguous`; empty structured locality
  remains explicit `missing`.
- Verification: 12 focused resolver/persistence tests passed. Python
  compilation and `git diff --check` passed.
- Independent task-verifier verdict: PARTIAL — the local decision and
  persistence path are covered, but production deployment and historical
  backfill are intentionally pending.
- Deployment/push: No production deployment or data write.
- Limitations: The full extraction test file still contains unrelated baseline
  failures documented above; this step does not change existing rows.
- Next action: Review the complete diff, then obtain approval for worker/API
  deployment before validating future production writes.

## 2026-09-05 — Consolidate authentication entry into restored landing page

- Requested outcome: Remove the obsolete standalone `/auth/login` visual page and use the new PropAI landing page as the single access entry, while restoring its broken layout structure.
- Changes: `frontend/src/app/auth/login/page.tsx` is now a small compatibility redirect that preserves safe `next` destinations; `frontend/src/app/page.tsx` opens the shared access panel from redirect parameters; `frontend/src/components/BrokerAccessPanel.tsx` accepts the destination; `frontend/src/app/globals.css` restores token-backed landing, signature, and access-panel structure. No backend, query, or data logic changed.
- Verification: Frontend production build passed with 73 routes. `git diff --check` passed. Raw legacy `broker-*` color variables and access-panel hardcoded colors were removed from the touched UI path. Independent task-verifier verdict: PARTIAL — local build and route wiring pass, but live screenshot verification is pending deployment.
- Deployment/push: Scoped commit `9708a641` was pushed to `redesign/propai-product-interface` and promoted to production `main` as `17000039`. Coolify `propai-lab:main-app` requires a manual redeploy; no deployment was triggered.
- Limitations: `/auth/login` remains as a redirect-only compatibility route so existing callers do not break; the old standalone UI is deleted. Production visual verification has not yet been performed.
- Next action: Manually redeploy `propai-lab:main-app`, then verify `/` and `/auth/login` in the signed-out production browser.

## 2026-09-06 — Separate building job completion from verified evidence

- Requested outcome: Explain why Google Places showed `COMPLETED` without an address, and connect enrichment rows to the canonical building/listing evidence chain.
- Changes: `frontend/src/app/admin/building-enrichment/page.tsx` now separates provider job status from evidence status and shows the recorded address or an explicit missing-evidence state. `supabase/migrations/20260905230000_expose_building_evidence_status.sql` extends the worker RPC with building address, place ID, source, confidence, latest history action, and derived evidence status. `architecture.md` documents the invariant. Existing links open the canonical building profile and its source-grounded listings.
- Verification: Frontend production build passed with 73 routes. `git diff --check` passed. Main contains commit `ce046bff`. Live verification is pending redeploy and migration application.
- Independent task-verifier verdict: PARTIAL — the local end-to-end response/UI path is implemented and pushed, but production has not yet applied the migration and the historical Kalpataru row has not been repaired.
- Deployment/push: `94e76e34` pushed to `redesign/propai-product-interface`; promoted as `ce046bff` to `main`. Coolify `propai-lab:main-app` requires a manual redeploy; no deployment was triggered.
- Limitations: The current data still proves no verified address was persisted for the screenshot row. This change makes that state explicit; it does not fabricate or infer an address. Direct Supabase production SQL verification was unavailable because the management API returned `Unauthorized`.
- Next action: Manually redeploy `propai-lab:main-app`, apply the new Supabase migration, then re-run the worker/API and verify the production enrichment response and building evidence page.

## 2026-09-06 — Prevent Copilot from obscuring the workspace

- Requested outcome: Restore visibility when the workspace Copilot is present and keep its drawer readable.
- Changes: `frontend/src/components/VoiceAssistant.tsx` no longer auto-opens the desktop Copilot on every page load. `frontend/src/app/globals.css` scopes the Copilot drawer to the shared light tokens for readable surface, border, text, and hover states.
- Verification: Elevated frontend production build passed with 73 routes. `git diff --check` passed. No data or backend logic changed.
- Independent task-verifier verdict: PARTIAL — the shared source fix and build pass, but live screenshot verification is pending deployment.
- Deployment/push: Pending commit and push in this session. Coolify `propai-lab:main-app` will require a manual redeploy; no deployment was triggered.
- Limitations: The screenshot cannot establish whether a separate browser overlay was active; source inspection confirms the Copilot was being auto-opened and had legacy dark-surface classes inside the light shell.
- Next action: Push and manually redeploy `propai-lab:main-app`, then verify Buildings and Copilot-open states in production.

## 2026-09-06 — Correct Buildings page foreground token

- Requested outcome: Restore readable building names and metrics on the Buildings directory.
- Changes: `frontend/src/app/buildings/page.tsx` now uses the foreground token for page headings and error copy. `frontend/src/app/globals.css` provides a scoped compatibility rule so remaining Buildings-page uses of the cream `--mist` surface token cannot render as low-contrast text.
- Verification: `git diff --check` passed. A full production build had already passed for the preceding Copilot change; this token-only patch still requires the same build/redeploy verification.
- Independent task-verifier verdict: PARTIAL — foreground correction is source-complete, but live visual verification is pending deployment. The list/profile source mismatch remains a separate data-contract issue.
- Deployment/push: Pending commit and push in this session. Coolify `propai-lab:main-app` requires a manual redeploy; no deployment was triggered.
- Limitations: The canonical name mismatch cannot be safely corrected from the screenshot alone. `/api/buildings` currently reads the legacy `storage.db` path while the profile endpoint reads the Supabase registry.
- Next action: Deploy the readability fix, then align the Buildings list endpoint with the same canonical Supabase source before re-running enrichment.

## 2026-09-06 — Align building directory and profile reads

- Requested outcome: Ensure the Buildings directory and the clicked building profile resolve the same canonical building record, avoiding the legacy SQL-adapter/list versus direct Supabase/profile mismatch.
- Changes: `routers/buildings.py` now reads `/api/buildings` through the tenant-scoped `storage.get_buildings()` path and calculates totals through `storage.count_buildings()`. `storage/supabase.py` adds status-aware listing/count methods, deterministic secondary ordering, and preserves `alias_count` with one bounded Supabase alias lookup. `architecture.md` records the shared canonical-registry invariant.
- Verification: `python3 -m compileall -q routers/buildings.py storage/supabase.py`, `git diff --check -- routers/buildings.py storage/supabase.py architecture.md`, and `pytest -q tests/test_source_boundary_regressions.py -q` passed (5 tests).
- Independent task-verifier verdict: PARTIAL — local source and regression checks pass, but production has not been redeployed and the live list/detail response pair has not yet been verified.
- Deployment/push: Dev commit `8962b58c` was pushed to `redesign/propai-product-interface` and promoted to production branch `main` as `5dcb0804`; the follow-up alias-count correction `35f86929` was promoted as `a103eeb8`. Coolify `propai-lab:main-app` requires a manual redeploy after this push; no deployment was triggered.
- Limitations: This prevents future list/profile source divergence but does not rename or merge historical building rows. If a canonical registry row itself has the wrong name, that remains a data-quality correction requiring source evidence.
- Next action: Manually redeploy `propai-lab:main-app`, then compare `/api/buildings` `building_id`/`canonical_name` with `/api/buildings/{building_id}` in the signed-in production session.

## 2026-09-06 — Make building counters follow linked evidence

- Requested outcome: Prevent a building directory row from showing stale listings/broker totals when the opened profile has no linked opportunities, and make the building FK the authoritative profile link.
- Changes: `storage/supabase.py` now recomputes directory listing, requirement, and broker counters from bounded typed-table `building_id` links, while retaining registry counters only as a fallback for partially migrated tables. `get_building_profile()` now trusts the immutable FK returned by `_fetch_typed_rows()` instead of filtering those linked rows back out by display-name text.
- Verification: `python3 -m compileall -q routers/buildings.py storage/supabase.py`, `git diff --check`, and `pytest -q tests/test_source_boundary_regressions.py -q` passed (5 tests).
- Independent task-verifier verdict: PARTIAL — the local source path and regression checks pass, but the production redeploy and live list/profile comparison are still pending.
- Deployment/push: Pending commit and push in this session. Coolify `propai-lab:main-app` requires a manual redeploy; no deployment was triggered.
- Limitations: Existing incorrect canonical building rows are not renamed automatically; only the directory/profile count and identity read contract is corrected.
- Next action: Push the scoped commit, manually redeploy `propai-lab:main-app`, and verify a directory row against its profile and linked opportunity count.

## 2026-09-06 — Compact Market Inbox card actions

- Requested outcome: Reduce the oversized WhatsApp and Add to CRM buttons on Market Inbox posts while preserving their actions and shared visual hierarchy.
- Changes: `frontend/src/app/inbox/page.tsx` now uses 32px-high compact action buttons with smaller padding, type, radius, and icons. `frontend/src/app/globals.css` updates the shared Market Inbox WhatsApp action minimum height and font size to match.
- Verification: Impeccable detector returned `[]`; `git diff --check` passed; frontend production build passed with placeholder Supabase environment and 73 routes.
- Independent task-verifier verdict: PARTIAL — source, detector, and build checks pass, but live visual verification is pending deployment.
- Deployment/push: Pending commit and push in this session. Coolify `propai-lab:main-app` requires a manual redeploy; no deployment was triggered.
- Limitations: This pass changes only Market Inbox card action sizing; no action/data logic was changed.
- Next action: Manually redeploy `propai-lab:main-app` and verify the compact buttons at desktop and mobile widths.

## 2026-09-06 — Harden public listing projection and source-boundary audit trail

- Requested outcome: Remove sensitive fields from the anonymous listing projection, authenticate raw-message search, make source-boundary drops auditable, make missing-price opportunity fingerprints non-colliding, and establish the extraction-stall cause.
- Changes: Added `source_boundary_drops` review metadata; made missing-price fingerprint input explicit; authenticated `/api/search/raw`; created and granted the buyer-facing `listings_unified_public` projection while revoking the legacy projection; repointed public listing consumers and server-side contact resolution. No extraction classifier, splitter, or dedupe algorithm was otherwise changed.
- Production migration: Applied via Supabase Management API with HTTP 201. The safe view has 52,035 rows, contains no sensitive columns, grants `anon` SELECT, and the legacy view denies `anon` SELECT. Existing production rows were not backfilled or rewritten.
- Verification: Public-site production build passed; targeted source-boundary/fingerprint assertions passed; Python compilation and `git diff --check` passed; live `/api/search/raw` without credentials returned 401; live public listing response exposed buyer-facing fields only. Extraction heartbeats were current with no worker error; recent outcomes show suppression/backlog behavior rather than a silent worker crash.
- Independent task-verifier verdict: PARTIAL — all code, migration, deployment, API-auth, catalog, and public-response checks passed, but a direct anonymous PostgREST request using the available publishable key could not be completed because that key was rejected with 401. The catalog and live response shape independently confirm the safe projection, but the exact requested anon HTTP query remains unverified.
- Deployment/push: Targeted commit `f6c88d9d` was pushed to `main`; API, public site, and dashboard services were deployed through Coolify. No production data rows were modified. `/home/vishal/supa.txt` was deleted successfully after use.
- Limitations: One unrelated pre-existing PSF idempotence test remains failing; the full extraction pipeline test import is blocked by missing `langgraph`. Existing over-collapsed opportunity keys were intentionally not backfilled in this pass.
- Next action: Run one authenticated-by-valid-publishable-key PostgREST canary against `listings_unified_public?select=broker_phone` and verify it returns a schema error/absent-column response, then promote this verifier result from PARTIAL if successful.

## 2026-09-06 — Promote source-grounding guard to production branch

- Requested outcome: Promote the extraction-worker locality/price recurrence fix to Coolify’s deployed branch.
- Changes: Integrated the scoped source-grounded typed-persistence guard, conservative price parser, tests, and architecture invariant into `main`.
- Verification: Focused source-price, locality, and backfill tests passed before promotion; no fresh production typed row was available for a post-redeploy canary.
- Independent task-verifier verdict: PARTIAL — promotion is complete, but the worker redeploy and fresh-row canary remain pending.
- Deployment/push: Remote `main` was synchronized before integration; no production data write was performed.
- Limitations: Ambiguous/no-match evidence remains unresolved by design.
- Next action: Push `main`, redeploy `extraction-worker`, wait for one fresh typed row, and verify locality/price completeness plus ambiguity blocking.

## 2026-09-06 — Complete extraction-worker deployment

- Requested outcome: Deploy the source-grounding recurrence fix to the production extraction workers.
- Verification: Coolify deployments for `extraction-worker` and `extraction-reprocessing-worker` both finished successfully on commit `e0c3444d`. The read-only Supabase canary found zero typed listing rows created since deployment; the latest typed rows predate the deployment.
- Independent task-verifier verdict: PARTIAL — deployment is verified, but the fresh-row behavior canary requires a new incoming WhatsApp message.
- Deployment/push: Main was pushed at `e0c3444d`; both worker deployments completed. No production data was written.
- Limitations: Locality/price behavior on a post-deploy message is not yet observed. Ambiguous/no-match evidence remains unresolved by design.
- Next action: Send or wait for one legitimate new property message, then audit the resulting typed row for locality/price persistence and ambiguity blocking.

## 2026-09-06 — Canary blocked by extraction-provider credits

- Requested outcome: Run a real production canary through the newly deployed extraction worker.
- Verification: Real queued WhatsApp message `raw_messages.id=899080` remained unprocessed after deployment. Worker logs show the configured extraction provider returning HTTP 402 because the request exceeds available OpenRouter credits/token allowance; no typed row was created.
- Independent task-verifier verdict: PARTIAL — deployment and commit selection are verified, but source-grounding behavior cannot be observed until extraction completes.
- Deployment/push: Both workers remain deployed on `e0c3444d`; no production data was manually written or fabricated.
- Limitations: Provider capacity, not the persistence guard, is currently preventing the canary. The queued real message should remain available for retry after provider capacity is restored.
- Next action: Restore extraction-provider credits or configure a provider with sufficient token capacity, then reprocess the queued real message and run the typed-row canary.

## 2026-09-06 — Enable OpenRouter free extraction lane

- Requested outcome: Use OpenRouter’s free extraction capacity while paid provider credits are unavailable.
- Changes: Coolify runtime/build variables for both extraction workers now enable the dedicated free lane and pin `EXTRACTION_OPENROUTER_MODEL` to `google/gemma-4-26b-a4b-it:free`. No key material was exposed, changed, or committed.
- Verification: Both workers redeployed successfully from `main`; logs show `extraction-openrouter-free` is being selected. The real queued canary now receives HTTP 429 rate-limit responses from the free lane; the secondary paid lane continues to return HTTP 402 for insufficient credits.
- Independent task-verifier verdict: PARTIAL — free-lane configuration and deployment are verified, but the canary cannot complete until the free-key rate limit resets or another free OpenRouter key is configured.
- Deployment/push: Configuration was applied through Coolify and both workers were redeployed. Documentation pushed to `main`.
- Limitations: The existing free credential is rate-limited; no typed row has been produced for the canary yet.
- Next action: Add/rotate an available free OpenRouter credential or wait for its rate-limit reset, then retry the queued real message.

## 2026-09-06 — Switch extraction to direct Gemini

- Requested outcome: Replace OpenRouter extraction with direct Gemini API usage.
- Changes: Added the provided Gemini API key as a Coolify runtime secret on both extraction workers, disabled OpenRouter extraction, and retained the existing direct Gemini model `gemini-3.1-flash-lite`.
- Verification: Both worker deployments completed successfully. Worker logs identify `Provider gemini`; a minimal direct Gemini API request returned HTTP 429 `RESOURCE_EXHAUSTED` stating that the AI Studio prepayment credits are depleted. The real queued message remains unprocessed.
- Independent task-verifier verdict: PARTIAL — direct Gemini wiring and deployment are verified, but Google has not authorized inference for this key.
- Deployment/push: No key material was committed or printed. Main documentation was pushed after the configuration rollout.
- Limitations: The Google Cloud promotional credits visible in Cloud Billing are separate from the AI Studio Gemini prepay balance and are not currently being consumed by this direct API key.
- Next action: In AI Studio Billing, add/activate Gemini prepay credits for the project/key, then retry the queued real message and run the typed-row canary.

## 2026-09-06 — Promote public marketplace redesign to production main

- Requested outcome: Make the Stitch-inspired public listing portal redesign live on `www.propai.live`, with clear residential/commercial terminology, source-grounded listing facts, latest-listing treatment, useful amenity icons, real listing photos when available, and improved map/detail layouts.
- Changes: Promoted the public-site listing-card, map, detail-page, title-quality, property-type terminology, public-data, migration, theme, and architecture changes from the design branch onto production `main`. `app.propai.live` was not changed.
- Verification: Public-site build and TypeScript checks passed on the source branch; listing-card tests passed; UI detector found no new violations in the changed surfaces; promoted worktree passed `git diff --check`.
- Independent task-verifier verdict: PASS for source promotion and scoped code changes.
- Deployment/push: Public redesign was pushed to `main`; after two build corrections, final commit `b938e5a6` deployed successfully to `propai-lab:main` via Coolify deployment `g7ogimjdulzom6zxxa2jpz5h`.
- Limitations: The public pages are live from the new commit; data-dependent visual differences still reflect the real inventory available in Supabase.
- Next action: Refresh `www.propai.live` with a hard reload to see the deployed public marketplace redesign.

## 2026-09-06 — Restore live homepage inventory and marketplace contrast

- Requested outcome: Ensure the homepage shows real live listings, remove the useless analysed-message counter, stop using BHK as the public property label, and make the marketplace visual change obvious.
- Changes: Made the homepage listing query compatible with the currently deployed public projection so optional amenity columns cannot blank the feed; replaced “Messages analysed” with “Listings tracked”; removed BHK from homepage suggestions, copy, fallback titles, and listing-card facts; strengthened the green/white marketplace contrast and card treatment.
- Verification: Clean public production build passed with TypeScript and all public routes generated; `git diff --check` passed.
- Independent task-verifier verdict: PASS — source, build, and Coolify deployment verified.
- Deployment/push: Pushed as `9d251ead`; Coolify deployment `e6vofpn4jqwuquxt5dqn0s6k` finished successfully for `propai-lab:main`; no `app.propai.live` changes.
- Limitations: Amenity chips remain source-grounded and appear only when the live projection exposes those fields.
- Next action: Hard-refresh the homepage and confirm live cards render below “Fresh inventory”.

## 2026-09-06 — Replace dead listing grid with marketplace cards and browse page

- Requested outcome: Make the public site feel like a real estate marketplace, ensure “View all listings” opens listings rather than search, and remove visible BHK terminology from the public browse experience.
- Changes: Rebuilt the listing-card composition with a Stitch-inspired visual header, type/freshness badges, property-type title treatment, price-first hierarchy, structured facts, source line, and “View details” action. Added a real SSR `/market/listings` page and routed homepage browse links there. Updated search helper language to use property type/residential wording.
- Verification: Clean production build passed; all public routes including `/market/listings` generated successfully; `git diff --check` passed.
- Independent task-verifier verdict: PASS — source, build, route, and Coolify deployment verified.
- Deployment/push: Pushed at `bac0f99c`; Coolify deployment `f309rnq74i77uy85n9nwzoem` finished successfully for `propai-lab:main`; `app.propai.live` remains untouched.
- Limitations: When a source listing has no photo, the card uses a clearly branded signal panel rather than invented property imagery.
- Next action: Hard-refresh `www.propai.live`; use “View all listings” to verify the new browse page.

## 2026-09-06 — Fix map-card save-button overlap

- Requested outcome: Prevent the Save listing control from overlapping status badges in the public map/listing cards.
- Changes: Reserved header space for the bookmark control so status/type/freshness badges wrap within their own layout area; normalized visible map-card titles away from BHK wording.
- Verification: Clean public production build passed and all public routes generated; `git diff --check` passed.
- Independent task-verifier verdict: PASS for source and build verification; deployment pending at report time.
- Deployment/push: Ready to push and redeploy `propai-lab:main`; `app.propai.live` remains untouched.
- Limitations: None known for the reported overlap at the supported responsive widths.
- Next action: Deploy and verify the map page at desktop and narrow widths.
## 2026-09-06 — Fix map-card save-button overlap

- Requested outcome: Prevent the Save listing control from overlapping status badges in public map/listing cards.
- Changes: Reserved header space for the bookmark control so status/type/freshness badges wrap within their own layout area; normalized visible map-card titles away from BHK wording.
- Verification: Clean public production build passed; `git diff --check` passed; Coolify deployment `ifay7bl5rb5di1ecrpndaauf` finished successfully for commit `7b22d417`.
- Independent task-verifier verdict: PASS — source, build, and deployment verified.
- Deployment/push: `main` pushed and `propai-lab:main` deployed; `app.propai.live` untouched.
- Limitations: None known for the reported overlap at supported responsive widths.
- Next action: Hard-refresh `/map` and verify the bookmark control at desktop and narrow widths.
## 2026-09-06 — Restore detail-page contact, source evidence, and address context

- Requested outcome: Make the broker WhatsApp CTA usable when a typed listing has a valid broker contact, show more source-grounded detail, and surface a listing/building address when available.
- Changes: Resolve contactability from the typed listing server-side without exposing phone numbers; load the listing-indexed source message for the detail page; redact contact numbers in rendered source evidence; use source street/address context when trusted building enrichment is unavailable.
- Verification: Clean public production build passed with all routes generated; `git diff --check` passed.
- Independent task-verifier verdict: PASS — source, build, and Coolify deployment verified.
- Deployment/push: Pushed at `005dd778`; Coolify deployment `izhjo6hgyor5hxsnwgd38m64` finished successfully for `propai-lab:main`; `app.propai.live` untouched.
- Limitations: A WhatsApp CTA remains unavailable when the source typed row has no valid broker phone; an address is shown only when source or trusted enrichment provides one.
- Next action: Hard-refresh a listing such as STEESHA and verify the CTA, source details, and address context.
## 2026-09-06 — Clean public listing titles and duplicate pulse entries

- Requested outcome: Stop showing the same Joy Legend rental signal twice across Khar West/Bandra West and remove WhatsApp markdown asterisks from public titles.
- Changes: Cleaned live ticker building names and title text, replaced BHK-based ticker language with residential/commercial sale/rental language, and deduplicated the homepage network pulse by building, property type, and transaction while retaining the full listing inventory elsewhere.
- Verification: Clean public production build passed; `git diff --check` passed.
- Independent task-verifier verdict: PASS — source, build, and Coolify deployment verified.
- Deployment/push: Pushed at `87370bd5`; Coolify deployment `f9cnw4lyi9mz1athl6p82yw9` finished successfully for `propai-lab:main`; `app.propai.live` untouched.
- Limitations: Listings with genuinely different units remain separate in the full inventory; deduplication is limited to the homepage teaser.
- Next action: Hard-refresh the homepage to verify clean pulse titles.
## 2026-09-06 — Fix homepage network-pulse 404 links

- Requested outcome: Stop homepage network-pulse listings from linking to stale or non-canonical detail URLs.
- Changes: Reused the canonical `toListingCardViewModel` href generation used by listing cards and detail pages instead of reconstructing slugs independently in the homepage pulse.
- Verification: Clean public production build passed with all routes generated; `git diff --check` passed.
- Independent task-verifier verdict: PASS — source, build, and Coolify deployment verified.
- Deployment/push: Pushed at `53795084`; Coolify deployment `zg6yf8kfzrheihvrjfkacm52` finished successfully for `propai-lab:main`; `app.propai.live` untouched.
- Limitations: Existing stale bookmarks outside the canonical route remain governed by the detail-page compatibility resolver.
- Next action: Hard-refresh the homepage and click each network-pulse row to verify it opens its listing detail page.

## 2026-09-06 — Resolve legacy public listing URLs

- Requested outcome: Make the existing `/listings/3-bhk-for-rent-khar-west-5544/5544` network-pulse URL resolve instead of showing the public 404 page.
- Changes: Added a compatibility resolver for pre-building-name slugs, matching their normalized transaction, configuration, locality, and numeric id against the source-grounded public candidates before canonical redirect. It also accepts legacy `rent`/`for-rent` and locality-field variants.
- Verification: Public `www` production build passed with TypeScript and all public routes generated; `git diff --check` passed; the exact reported URL was opened in a real browser after deployment and rendered the Joy Legend listing detail instead of the visible 404 state.
- Independent task-verifier verdict: PASS — the legacy resolver accepts the old numeric BHK/intention/locality slug shape and the production browser check confirms the user-visible result.
- Deployment/push: Final commit `76e976c1` was pushed to `main`; Coolify deployment `s11y1rvu8sy4i39z7z0lwey3` finished successfully for `propai-lab:main`; `app.propai.live` untouched.
- Limitations: Legacy URLs can resolve only when their id and locality/configuration identify a single eligible public listing.
- Next action: Hard-refresh the existing browser tab once so it picks up the deployed route; no further code action is required for this 404.

## 2026-09-06 — Correct public market snapshot metric definitions

- Requested outcome: Replace misleading homepage counters with live, defensible public metrics and stop using the curated eight-locality navigation list as the locality total.
- Changes: Added `get_public_market_metrics()` migration contract for total public listings, listings seen in the last 7 days, distinct attached brokers, and distinct locality values. Updated the homepage to use the RPC locality count and label freshness as “seen in the last 7 days”; removed the unsafe fallback to the older aggregate RPC.
- Verification: Direct Supabase read-only query returned 52,042 public listings, 12,694 seen in 7 days, 1,342 distinct attached brokers, and 547 distinct coalesced locality values; public production build passed with TypeScript and all routes generated; `git diff --check` passed.
- Independent task-verifier verdict: PASS — direct Supabase verification returned 52,042 total listings, 12,675 seen in 7 days, 1,342 distinct attached brokers, and 547 distinct public-projection locality values; the deployed homepage DOM shows the same values and definitions.
- Deployment/push: Migration applied to the live Supabase project; code and migration pushed in commit `cbab3277`; Coolify deployment completed successfully for `propai-lab:main`; `app.propai.live` remains untouched.
- Limitations: The 547 locality result uses the public projection’s coalesced locality expression; a 522 result requires the narrower normalization rule used by the separate audit query. The UI now reports the exact expression used rather than silently claiming a different definition.
- Next action: None for this metric correction.

## 2026-09-06 — Use broker source brief and add listing location map

- Requested outcome: Stop repeating the composed listing title in “About this listing” and use the broker’s raw source data for the short description; use the unused detail-page space for a map below each listing.
- Changes: Prefer a cleaned, phone-redacted broker source brief for the public listing description, keeping the normalized title separate. Added a responsive Google Maps embed using the source/trusted building-locality context, with an exact-address confirmation note.
- Verification: Public production build passed for the description/map changes; `git diff --check` passed. Production HTML contains the broker-source description section and Google Maps embed, without the repeated generated sentence. A fresh clean-worktree TypeScript check surfaced an unrelated pre-existing `test/natural-search.test.ts` fixture type error.
- Independent task-verifier verdict: PASS — typed source message loading, phone-redacted source copy, map rendering, and production deployment are verified.
- Deployment/push: Final source-loader commit `718ebb14` pushed; Coolify deployment `o13k1d6zo5b2k9nduboxvr8b` finished successfully for `propai-lab:main`; `app.propai.live` untouched.
- Limitations: The map is building/locality-level when an exact trusted address is unavailable; it does not invent a flat-level location.
- Next action: Hard-refresh the listing page to see the broker-source description and map.

## 2026-09-06 — Present generated listing copy and verified building address

- Requested outcome: Hide the broker’s raw WhatsApp message from customers, generate a concise description from its facts, and show Joy Legend’s enriched address.
- Changes: Removed the public “View original message” accordion; retained the source message only as server-side input to the description generator. The generated copy now includes the residential type, configuration, building, locality, carpet area, parking, and rent without repeating the title. Corrected the public building lookup from the nonexistent `buildings_public` relation to the live `buildings` table.
- Verification: Live Supabase query found Joy Legend’s verified Google Places record and address. Production smoke check returned HTTP 200 in 13.8s and contained `Semi furnished 3 BHK residential at joy Legend in Khar West. 1,519 sqft carpet area with 2 car parking. For rent at ₹3.5 Lakh/month.`, the enriched address, and the map embed; it contained no `View original message`. `git diff --check` passed and Coolify build completed successfully.
- Independent task-verifier verdict: PASS — all requested customer-visible conditions are present in production with source-grounded data and no raw-message UI.
- Deployment/push: Final commit `6c161d1` pushed; Coolify deployment `unfimyzp2bduzs75q44im6ya` finished successfully for `propai-lab:main`; `app.propai.live` untouched.
- Limitations: The map is building-level/locality-level context, not a flat-level location; exact visiting details should still be confirmed with the broker.
- Next action: Hard-refresh the open listing tab to clear the previous skeleton response.

## 2026-09-06 — Restore the public building projection contract

- Requested outcome: Ensure the building lookup does not regress because of a mismatch between the live database schema and public-site queries.
- Changes: Applied `20260903090000_public_site_read_projection.sql` to the live Supabase project, restoring `public.buildings_public` from `public.buildings` with the intended public columns and grants. Restored all affected public-site lookup paths to use `buildings_public` rather than relying on a direct base-table exception.
- Verification: Live schema query confirms `public.buildings_public` exists. Joy Legend remains enriched through the projection, and the exact public detail URL returned HTTP 200 after deployment. `git diff --check` passed.
- Independent task-verifier verdict: PASS — the live projection exists, public reads use the projection, and the listing route remains healthy after the migration.
- Deployment/push: Migration applied live; schema-aligned code pushed and deployed on `propai-lab:main` (Coolify deployment `eu9b9eo79blc6euie79bjdbl` finished successfully); `app.propai.live` untouched.
- Limitations: Future schema changes still require their migration to be applied to production; the repository migration and live schema now agree.
- Next action: Keep the public projection migration in the normal production migration rollout whenever database changes are promoted.
## 2026-09-06 — Harden automated building identity authority and junk discovery

- Requested outcome: Prevent `Config`/`Configuration` from becoming buildings, avoid duplicate registry entries, reuse verified Google building identity across boundary-area labels, and keep likely-nonexistent buildings from being treated as enriched.
- Changes: Added deterministic configuration-label rejection in `building_quality.py` and `extraction_quality.py`; added verified-Google identity reuse in `SupabaseStorage.create_building`; added an `unresolved` state after terminal enrichment failure; added a migration that quarantines existing configuration-only rows and merges exact same-tenant Google Place duplicates while preserving typed listings and raw evidence.
- Verification: The new configuration guard test passes; Python compilation and `git diff --check` pass. Live migration completed successfully. Configuration-only rows are quarantined, and no duplicate Google Place IDs remain within a tenant. Tenant-separated records remain separate by design.
- Independent task-verifier verdict: PARTIAL — database cleanup and building-enrichment worker deployment are verified, but the extraction-worker redeploy could not be completed because Coolify was unreachable on two attempts.
- Deployment/push: Commit `fa14545` pushed. Migration applied to live Supabase. `propai-lab:enrichment` deployment `rw2rxf7o4q5rks72ue11gxa6` finished successfully. `extraction-worker` deployment was blocked by Coolify connectivity; `app.propai.live` untouched.
- Limitations: Cross-tenant buildings are not merged because tenant boundaries must remain isolated. Redevelopment renames still require a verified alias/Google identity before they become one building. New extraction messages will use the guard once the extraction-worker redeploy succeeds.
- Next action: Retry deployment of `fpmr99xoi9qc7bdclals8jzb` when `coolify.propai.live` is reachable, then process one new test message and verify no configuration building is created.

## 2026-09-06 — Promote verified building-address copy to production main

- Requested outcome: Put the public listing address/description fix on `main` without promoting unrelated redesign or data-source changes.
- Changes: Promoted the address-aware SEO and visible listing-description code; added a narrow canonical-building alias fallback before using the broker street field. `app.propai.live` was not changed.
- Verification: Public `apps/www` webpack production build passed with TypeScript and static generation; scoped whitespace and UI checks passed. Independent task-verifier verdict: PARTIAL — source wiring and responsive desktop/mobile component coverage pass, but live production rendering remains pending redeployment and browser verification.
- Deployment/push: Scoped promotion was pushed to `main` at commit `ec2d1626`. Coolify `propai-lab:main` must deploy this commit before the fix is live; `app.propai.live` was not changed.
- Limitations: Listings without a trusted Google-enriched address continue to use source/locality context; no address is fabricated. Live production browser verification remains pending.
- Next action: Redeploy `propai-lab:main`, then browser-check a known enriched listing at desktop and mobile widths.

## 2026-09-07 — Restore extraction queue and Sarvam fallback

- Requested outcome: Investigate extraction-worker timeouts and make the newly configured Sarvam fallback usable in production.
- Changes: Added the tenant-leading `(tenant_id, timestamp, id)` partial index matching the worker's recent FIFO query; promoted Sarvam to production `main`; and changed Sarvam extraction reasoning from unsupported `none` to accepted `low`.
- Verification: Production index exists; the worker container reports `EXTRACTION_SARVAM_API_KEY` present and `EXTRACTION_SARVAM_MODEL=sarvam-105b`; provider list includes `extraction-sarvam`; focused Sarvam test passed; Coolify deployment `dm5gbtk5ngngnxf3ppzsuo5o` finished on commit `7e8d08f7`. Post-deployment logs no longer show the Supabase queue timeout or Sarvam 400 reasoning errors.
- Independent task-verifier verdict: PARTIAL — deployment and provider wiring are verified, but an eligible listing has not yet completed through Sarvam because the current cycle is suppressing unselected groups.
- Deployment/push: Migration applied to live Supabase. Production `main` contains the code at `7e8d08f7`; extraction-worker deployment completed successfully. No public-site or dashboard deployment was needed for this worker fix.
- Limitations: Existing dedupe `409` conflicts are expected idempotency races. The remaining `asset_type` validation warnings require model-output quality follow-up if they recur on eligible listings.
- Next action: Process one eligible selected-group listing and confirm a stored extraction using Sarvam, then monitor the backlog latency.

## 2026-09-07 — Make Sarvam primary for extraction

- Requested outcome: Use the available Sarvam credit balance for extraction before consuming NVIDIA credits.
- Changes: Sarvam is now the deterministic first provider whenever `EXTRACTION_SARVAM_*` is configured; NVIDIA and other providers remain fallbacks. The fallback-order test now asserts Sarvam is selected on attempt one.
- Verification: Focused Sarvam ordering tests passed 2/2; production commit `c3625dc9` deployed successfully as Coolify deployment `x11qx7qcgxs89emjyrddu7p3`.
- Independent task-verifier verdict: PARTIAL — source ordering and deployment are verified; no eligible selected-group message arrived during the observation window, so a live Sarvam-first extraction call remains pending.
- Deployment/push: Pushed to `main`; extraction-worker is running the new commit. No public-site or dashboard service changed.
- Limitations: Unselected groups are intentionally suppressed and do not exercise the provider chain.
- Next action: Process the next eligible selected-group listing and confirm the logs show Sarvam before any NVIDIA attempt.

## 2026-09-07 — Improve Chat message contrast

- Requested outcome: Make the Chat conversation text readable in the live dashboard.
- Changes: Darkened assistant reply text, user message text, and secondary message text within the Chat message area only; no data or search behavior changed.
- Verification: Impeccable UI detector returned no findings; scoped `git diff --check` passed; the frontend webpack production build passed and generated all routes.
- Independent task-verifier verdict: PARTIAL — source and production build checks pass, but live browser recheck is pending because the browser connector is unavailable in this session.
- Deployment/push: Scoped Chat contrast fix is present on remote `main` at `d6ef89fc`; Coolify `propai-lab:main-app` must redeploy it before the contrast change is live.
- Limitations: The current live screenshot cannot be rechecked from this session; after deployment, hard-refresh the Chat page to clear cached CSS.
- Next action: Redeploy `propai-lab:main-app`, hard-refresh `/chat`, and confirm assistant and user messages are visibly dark enough.

## 2026-09-07 — Improve public listing detail completeness and hierarchy

- Requested outcome: Make public listing detail pages feel complete and readable, with available property details represented clearly instead of a dominant title, sparse summary, and ambiguous locality state.
- Changes: `apps/www/src/app/listings/[slug]/[id]/page.tsx` now combines typed listing fields with detail fields, shows area and additional source-grounded facts, uses a richer generated summary when stored copy is too thin, labels unresolved location honestly, and reduces title dominance. `apps/www/src/app/public-theme.css` adds light-theme styling for the details and summary blocks.
- Verification: `apps/www` `next build --webpack` passed with all public routes generated; scoped `git diff --check` passed; Impeccable detector reported only pre-existing gray-on-green warnings at unrelated theme lines 88 and 107.
- Deployment/push: Scoped commit `60f4c5bd` was pushed to `main`. Coolify service `propai-lab:main` needs redeployment for `www.propai.live`; no production data was changed.
- Independent task-verifier verdict: PARTIAL — the source changes and production build are verified, but the live listing cannot be confirmed until `propai-lab:main` is redeployed and the URL is rechecked.
- Limitations: The supplied screenshot was production UI, but this session did not have a browser control path to recheck the same live listing after deployment.
- Next action: Push and redeploy `propai-lab:main`, then reopen the same listing and confirm the details grid, generated summary, and location state.

## 2026-09-07 — Fix Chat locality result filtering

- Requested outcome: Make Chat return the available 2 BHK Bandra East rental options shown in the live market data.
- Changes: Preserved `locality_raw` and `locality_resolved` while converting Supabase rows into Chat cards, and used the resolved locality as the visible card location when `micro_market` is empty.
- Verification: Read-only Supabase query confirmed an exact fresh 2 BHK Bandra East rental (`BC Corp`, ₹1.2 lakh/month). Python compilation and scoped `git diff --check` passed; Impeccable detector returned no findings. The focused pytest timed out after 30 seconds during backend import in this environment.
- Independent task-verifier verdict: PARTIAL — live database evidence and source checks pass, but the focused pytest and live browser confirmation remain pending.
- Deployment/push: Scoped commit `fb2b2420` was pushed to `main`; Coolify `propai-lab:main-app` must redeploy before Chat uses the corrected adapter.
- Limitations: The screenshot was not rechecked from this session because the browser connector is unavailable.
- Next action: Redeploy `propai-lab:main-app`, hard-refresh Chat, and search “2 bhk for rent in Bandra East” to confirm the BC Corp option appears.

## 2026-09-07 — Keep Chat agent useful when the model is unavailable

- Requested outcome: Make Chat behave like a useful property-search agent even when AI credits are exhausted, while preserving live-data grounding.
- Changes: Database fallback now runs before the provider-credit error for inventory queries. Short locality additions such as “and BKC?” inherit the previous BHK, intent, and search context and add the new market.
- Verification: Python compilation and scoped `git diff --check` passed. Regression coverage was added for resolved-locality card output and contextual locality follow-ups. The repository pytest import previously timed out after 30 seconds during backend initialization.
- Independent task-verifier verdict: PARTIAL — source checks and live Supabase evidence pass, but live browser verification and a completed focused pytest run remain pending.
- Deployment/push: Pending scoped commit and push; Coolify `propai-lab:main-app` must redeploy before this behavior is live.
- Limitations: Without a working model provider, general conversation remains limited; grounded listing search and follow-ups will still work without LLM credits.
- Next action: Redeploy the dashboard, hard-refresh Chat, and test “2 bhk for rent in Bandra East” followed by “and BKC?”.

## 2026-09-07 — Normalize public listing detail theme and heading scale

- Requested outcome: Remove the mixed light/dark styling and oversized heading visible on the public listing detail page, and clarify why only one listing appears on a detail URL.
- Changes: Scoped the listing detail surfaces to the light public theme, removed dark card backgrounds from the visible specs, reduced the responsive title scale, and retained source-grounded rendering. A detail URL intentionally shows one primary listing; the Similar listings panel remains conditional on live qualifying matches.
- Verification: `apps/www` `next build --webpack` passed with TypeScript and all routes generated; scoped `git diff --check` passed; Impeccable detector reported only pre-existing warnings at unrelated theme lines 88 and 107.
- Deployment/push: Scoped commit `3c2b81dc` was pushed to `main`. Coolify service `propai-lab:main` needs redeployment for `www.propai.live`.
- Independent task-verifier verdict: PARTIAL — source and build checks pass, but live visual verification remains pending redeployment.
- Limitations: No related listings are shown when the live similarity query returns no safe matches; no inventory was fabricated to fill that space.
- Next action: Push and redeploy `propai-lab:main`, then hard-refresh the listing URL and confirm the heading scale and color consistency.

## 2026-09-07 — Fix listing-detail title scale and status alignment

- Requested outcome: Reduce oversized commercial listing titles and align the location, verification, and freshness labels consistently.
- Changes: Added shared responsive title sizing and a common inline-flex pill treatment for listing status labels, with light-theme colors and spacing.
- Verification: `apps/www` `next build --webpack` passed with TypeScript and all routes generated; scoped `git diff --check` passed; detector reported only pre-existing green-button gray-text warnings.
- Deployment/push: Pending scoped commit and push. Coolify service `propai-lab:main` needs redeployment for `www.propai.live`.
- Independent task-verifier verdict: PARTIAL — source and build checks pass, but live visual verification remains pending redeployment.
- Limitations: No live browser verification was available after the change.
- Next action: Push and redeploy `propai-lab:main`, then check a long commercial title and a listing with freshness/status badges.

## 2026-09-07 — Fix public listing copy and WhatsApp contact disambiguation

- Requested outcome: Remove duplicated commercial wording from generated listing copy and make the WhatsApp CTA resolve the correct broker when numeric IDs overlap across typed listing tables.
- Changes: `listingDescription` now uses the title once and appends only missing location facts. The contact URL now carries the listing `card_type`, and the server filters by that type before resolving the broker phone.
- Verification: `apps/www` `next build --webpack` passed with TypeScript and all routes generated; scoped `git diff --check` passed.
- Deployment/push: Pending scoped commit and push. Coolify service `propai-lab:main` needs redeployment for the copy/contact fix.
- Independent task-verifier verdict: PARTIAL — source and build checks pass, but live description and WhatsApp redirect verification remain pending redeployment.
- Limitations: The exact live database candidate set was not queried in this session; the fix addresses the observed `ambiguous_listing` response path.
- Next action: Push and redeploy `propai-lab:main`, then test the commercial listing CTA and confirm WhatsApp opens with the listing link.

## 2026-09-07 — Disable Sarvam reasoning for structured extraction

- Requested outcome: Fix extraction reliability despite Sarvam API usage showing successful traffic.
- Changes: Removed `reasoning_effort=low` from the extraction-only Sarvam provider and reduced its structured-output budget to 4096 tokens, preventing reasoning from consuming the response before final JSON is emitted. Updated the focused provider test.
- Verification: Sarvam provider tests passed (`2 passed`); Python compilation and scoped `git diff --check` passed. The full provider-order file still has two unrelated pre-existing priority expectation failures.
- Deployment/push: Pending scoped commit and push. Coolify service `extraction-worker` needs redeployment for the fix to run.
- Independent task-verifier verdict: PARTIAL — source and focused tests pass, but live provider success requires redeployment and a fresh extraction canary.
- Limitations: NVIDIA overloads, missing Doubleword credentials, omitted `asset_type`, and dedupe conflicts are separate issues; this fix targets Sarvam incomplete-output failures.
- Next action: Push and redeploy `extraction-worker`, then verify a fresh message produces valid typed JSON without `finish=length`.

## 2026-09-07 — Prevent Chat history from disappearing during hydration

- Requested outcome: Keep an existing Chat conversation visible after refreshes, remounts, and session restoration.
- Changes: Fixed the session bootstrap race that could skip hydration during React remounts, and prevented a transient empty history response from erasing an already rendered transcript.
- Verification: Supabase confirmed the visible session still contains 17 messages; frontend webpack production build passed with all 74 routes generated; scoped `git diff --check` passed; Impeccable detector returned no findings.
- Independent task-verifier verdict: PARTIAL — database persistence, source checks, and build pass, but live browser confirmation remains pending because the browser connector is unavailable.
- Deployment/push: Pending scoped commit and push; Coolify `propai-lab:main-app` must redeploy before the fix is live.
- Limitations: The existing browser session must be hard-refreshed after deployment; no stored chat data was changed.
- Next action: Redeploy `propai-lab:main-app`, open the same Chat URL, and confirm the 17-message transcript remains visible.


## 2026-09-07 — Add safe same-building recommendations to listing details

- Requested outcome: Use the reference property-detail layout as inspiration and make the right rail capable of showing more real listings without fabricating inventory.
- Changes: The public detail page now labels the recommendation rail “More listings”; the similarity query can recommend fresh, compatible listings from the exact same building even when locality enrichment is pending, while preserving unit separation and repost filtering.
- Verification: `apps/www` `next build --webpack` passed with TypeScript and all routes generated; scoped `git diff --check` passed; Impeccable detector reported only pre-existing warnings at unrelated theme lines 88 and 107.
- Deployment/push: Pending scoped commit and push. Coolify service `propai-lab:main` needs redeployment for `www.propai.live`.
- Independent task-verifier verdict: PARTIAL — source and build checks pass, but live recommendations and visual rendering remain pending redeployment.
- Limitations: If no fresh compatible same-building listings exist, the rail remains absent rather than showing unrelated or fabricated inventory.
- Next action: Push and redeploy `propai-lab:main`, then reopen listing `9976` and verify the right rail when matching inventory exists.

## 2026-09-07 — Present Chat search results as a separated list

- Requested outcome: Make Chat search results easier to scan by separating each search response and showing its listings in a readable spreadsheet-style list instead of a two-column card grid.
- Changes: Chat-only structured listing responses now render inside a bordered result group with one listing per table row and columns for property, locality, type, price, area, furnishing, broker, recency, photos, contact, and actions. Market Inbox presentation was left unchanged.
- Verification: Impeccable detector returned no findings; scoped `git diff --check` passed; the frontend webpack production build passed and generated all 74 routes.
- Independent task-verifier verdict: PARTIAL — the source and production build checks pass, but live browser verification remains pending because the browser connector is unavailable in this session.
- Deployment/push: Pending scoped commit and push. Coolify service `propai-lab:main-app` needs redeployment before the change is live.
- Limitations: The list layout is verified in source/build only; after deployment the existing Chat URL must be hard-refreshed to confirm the live visual result.
- Next action: Redeploy `propai-lab:main-app`, hard-refresh Chat, and confirm separate search groups with one listing per row.

## 2026-09-07 — Answer building-location questions without inventory results

- Requested outcome: When a broker asks “where is [building]?”, answer the building’s recorded locality/address instead of launching a listing search.
- Changes: Added a grounded building-directory lookup before the market-search agent route. It returns a concise location answer, preserves the source route, and does not attach listing cards.
- Verification: Added regression coverage for location-question detection versus inventory queries; Python compilation and focused helper tests passed; the live browser was not available for recheck.
- Independent task-verifier verdict: PARTIAL — source and regression checks pass, but the production deployment and live Chat behavior remain pending.
- Deployment/push: Pending scoped commit and push. Coolify service `propai-lab:main-app` needs redeployment before this behavior is live.
- Limitations: If the building is not in the directory, Chat reports that honestly rather than guessing a location.
- Next action: Redeploy `propai-lab:main-app`, start a fresh Chat, and ask “where is Rustomjee Paramount?”; it should return location text only.

## 2026-09-07 — Preserve broker notes from WhatsApp listings

- Requested outcome: Review the Bandra broker WhatsApp export and capture the additional negotiation, legal, charge, access, media, utility, tenant, building, unit, and brokerage notes that did not have a guaranteed structured destination.
- Changes: Added a bounded `broker_notes` JSON array to all eight live typed listing/requirement tables. The unified and focused extraction prompts now require item-local notes with category, faithful text, and source wording. Added normalization, persistence, storage-model, and internal-read support while keeping notes out of public projections and SEO copy. Updated the architecture and data-quality contracts.
- Verification: Reviewed the supplied archive (27,720 message headers; 1,070,254 lines) and sampled real patterns including negotiability, clear title, maintenance, inspection notice, media availability, utilities, redevelopment/conversion, mandates, and unit structure. Focused broker-note tests passed 3/3; Python compilation and scoped diff checks passed. Live Supabase query confirms `broker_notes` on all eight typed tables.
- Independent task-verifier verdict: PARTIAL — prompt, validation, persistence, schema, and live migration are verified; the broader extraction test collection is blocked in this environment because `langgraph` is not installed, and the new extraction path has not yet been redeployed and exercised by a live WhatsApp message.
- Deployment/push: The additive migration is applied to the live Supabase project. Code still requires deployment of `extraction-worker` and `api`; no public-site or dashboard deployment is required for this backend extraction change. Unrelated dirty files were not staged.
- Limitations: `broker_notes` preserves explicit source-grounded notes not represented by typed fields; it does not replace typed extraction. Existing rows are not backfilled automatically.
- Next action: Push this commit, redeploy `extraction-worker` and `api`, then process one eligible selected-group message and verify the stored `broker_notes` JSON.

## 2026-09-07 — Prevent broker metadata from blocking typed extraction

- Requested outcome: Diagnose the deployed worker failures and ensure valid listings are not discarded when transport broker identity is absent from an item slice or Sarvam truncates before JSON.
- Changes: Carried the WhatsApp transport-identity marker through `ParsedObservation`; secondary ungrounded company/RERA fields are now dropped without blocking a transport-attributed listing; increased the extraction-only Sarvam output budget from 4096 to 8192 tokens.
- Verification: Focused broker-grounding and Sarvam-provider tests passed 2/2; Python compilation and scoped diff checks passed. The broader suite still has unrelated pre-existing price-sanity and provider-priority expectation failures.
- Deployment/push: Code requires redeployment of `extraction-worker`; no database migration is required. The pasted logs show dedupe 409s (expected idempotency conflicts), NVIDIA 502/timeouts, Sarvam `finish=length`, and the broker source-evidence persistence failure.
- Independent task-verifier verdict: PARTIAL — local fix and focused regression coverage pass, but a fresh production extraction has not yet verified the new worker behavior.
- Limitations: This does not cure NVIDIA upstream overloads or configure the optional Doubleword provider. Expired messages remain excluded by the 24-hour extraction window and require an explicit backfill policy.
- Next action: Push this fix, redeploy `extraction-worker`, and verify one fresh selected-group message writes a typed row without the broker-evidence block or Sarvam `finish=length`.

## 2026-09-07 — Add optional Sarvam Gemma 4 extraction fallback

- Requested outcome: Add a Sarvam-hosted open-source model as a safer structured-extraction fallback.
- Changes: Added opt-in `extraction-sarvam-gemma4` on Sarvam `/v2`, defaulting to `gemma4` with an 8,192-token budget. Added Coolify wiring and deployment documentation. It activates only when `EXTRACTION_SARVAM_OPEN_SOURCE_API_KEY` is present.
- Verification: Python compilation, focused Sarvam provider tests, and scoped diff checks passed (`3 passed`).
- Deployment/push: Pending scoped commit and push. Coolify service `extraction-worker` needs redeployment after adding the beta-access key variable.
- Independent task-verifier verdict: PARTIAL — provider construction and configuration are verified locally; live beta whitelist access and a production extraction canary remain unverified.
- Limitations: Sarvam requires beta access for `gemma4`; a refused key will not be silently treated as a successful provider. No API or database migration is required.
- Next action: Add `EXTRACTION_SARVAM_OPEN_SOURCE_API_KEY` in the extraction-worker service, optionally set `EXTRACTION_SARVAM_OPEN_SOURCE_MODEL=gemma4`, redeploy, and verify the worker logs show the provider only when enabled.

## 2026-09-07 — Explicitly disable Sarvam reasoning for JSON extraction

- Requested outcome: Stop Sarvam 105B from consuming the entire extraction response budget with hidden reasoning and returning `finish=length` without JSON.
- Changes: Sarvam extraction providers now send an explicit `reasoning_effort: null`; omitting the field had allowed Sarvam’s default low reasoning mode to remain active. Added a request-level regression test.
- Verification: Focused Sarvam/provider tests passed (`4 passed`); Python compilation and scoped diff checks passed.
- Deployment/push: Pending scoped commit and push. Coolify service `extraction-worker` needs redeployment.
- Independent task-verifier verdict: PARTIAL — request construction and regression tests pass, but a fresh production extraction is required to confirm Sarvam returns final JSON.
- Limitations: The unavailable-message RPC warning and expected dedupe conflicts are separate lifecycle/idempotency messages; NVIDIA upstream failures are unaffected.
- Next action: Redeploy `extraction-worker` and verify the next Sarvam call has no `finish=length` warning and writes a typed row.

## 2026-09-07 — Separate WhatsApp group consent from live membership

- Requested outcome: Make the group-control UI truthful when a group was exited in WhatsApp but remains selected in PropAI’s consent table.
- Changes: The onboarding API now exposes `membership_status`, preserves selected-but-missing groups for cleanup, and avoids reconstructing stale persisted groups after a successful empty directory query. The dashboard adds “Refresh membership” and labels missing groups “Selected · membership unconfirmed” instead of “Included · reading messages”.
- Verification: Backend Python compilation and scoped diff checks passed. The internal dashboard webpack production build passed and generated all 74 routes. Turbopack was separately blocked by the sandbox’s process/port permission while parsing CSS.
- Deployment/push: Pending scoped commit and push. Coolify services `api` and `propai-lab:main-app` need redeployment.
- Independent task-verifier verdict: PARTIAL — source and build checks pass, but live WhatsApp refresh and an exited-group confirmation remain pending deployment.
- Limitations: “Not in latest directory” is intentionally not presented as definitive proof of exit until a fresh directory refresh completes; existing extraction consent remains unchanged until the user unchecks/confirms it.
- Next action: Redeploy `api` and `propai-lab:main-app`, click “Refresh membership”, and confirm exited groups are marked unconfirmed and can be deselected.

## 2026-09-07 — Send Chat prompts in Sarvam-compatible format

- Requested outcome: Stop Chat from incorrectly reporting exhausted AI credits when Sarvam is configured and available.
- Changes: Added provider-aware Chat message preparation. Sarvam now receives plain string message content, while providers supporting prompt caching retain cached content blocks. Added regression coverage for both paths.
- Verification: Focused provider tests passed 4/4; Python compilation passed for the changed backend modules; scoped `git diff --check` passed. Production logs confirmed Sarvam was reached and rejected the previous content-block format, while the backup provider had low balance.
- Independent task-verifier verdict: PARTIAL — the fix covers the live failing call path and local tests pass, but production behavior still requires deployment and a fresh Chat request.
- Deployment/push: Pending scoped commit and push. Coolify service `api` needs redeployment; no database migration is required.
- Limitations: The configured backup Doubleword provider still has low balance, so Sarvam must accept the corrected request for Chat to work without fallback.
- Next action: Redeploy `api`, hard-refresh Chat, and ask “where is Rustomjee Paramount?”; it should answer from the building directory without the exhausted message.

## 2026-09-07 — Trust Google address evidence over source locality mismatch

- Requested outcome: Accept a strong Google Places address even when WhatsApp locality context differs, and make the enrichment failure panel readable.
- Changes: Removed locality-mismatch rejection from the Google Places provider and worker path. Google address evidence is now saved when building identity confidence is strong; any source-locality difference is retained as an enrichment-history note. Updated the Latest failure panel to use readable dark text on the light admin surface and clarified the empty state styling.
- Verification: Building enrichment and discovery tests passed 56/56; frontend production build passed with all 74 routes; scoped `git diff --check` passed; Impeccable detector returned no findings.
- Independent task-verifier verdict: PARTIAL — local provider/worker behavior and UI build are verified, but production worker redeployment and a fresh live enrichment job remain pending.
- Deployment/push: Pending scoped commit and push. Coolify services `propai-lab:enrichment` and `propai-lab:main-app` require redeployment.
- Limitations: Ambiguous same-name Google results and weak building-name matches remain blocked, correctly; this change only removes locality mismatch as an automatic blocker.
- Next action: Redeploy the enrichment worker and dashboard, then verify a fresh locality-conflict job records Google’s address and displays the readable failure panel for a genuine failed job.

## 2026-09-07 — Improve semantic embeddings dashboard contrast

- Requested outcome: Make the many low-contrast labels, statuses, and gate results on the embeddings pipeline screen readable.
- Changes: Updated the shared light-shell color bridge for red and amber Tailwind status text, including failed-gate alerts and warning metrics. The existing embeddings page now renders these states with accessible dark foreground colors on the light dashboard surface.
- Verification: Frontend production build passed with all 74 routes; Impeccable detector returned no findings; scoped `git diff --check` passed.
- Independent task-verifier verdict: PARTIAL — source and build verification pass, but live visual confirmation remains pending deployment and browser refresh.
- Deployment/push: Pending scoped commit and push. Coolify service `propai-lab:main-app` needs redeployment.
- Limitations: This fixes the shared red/amber contrast mappings used by the embeddings screen; other unrelated admin surfaces may contain separate legacy styling issues.
- Next action: Redeploy `propai-lab:main-app`, hard-refresh Pipeline Health → Embeddings, and confirm failed, warning, and supporting text are readable.

## 2026-09-07 — Show source-grounded commercial listing details

- Requested outcome: Show the additional office facts already present in the broker source instead of rendering only a small typed subset on public listing pages.
- Changes: Extended the public listing detail projection for commercial sale/rent rows to include workstations, cabin counts, conference and meeting rooms, server/storage/reception areas, pantry, washrooms, cafeteria seats, power load, rent basis, and related office facts. Added safe labels and units to the SSR property-details section; raw WhatsApp text and private contact fields remain excluded.
- Verification: Live source query for listing `10103` confirmed the commercial source contains 6,800 carpet sqft, 11,500 built-up sqft, approximately 140 workstations, director/manager cabins, conference/meeting rooms, server room, washrooms, pantry, and other office details. Impeccable detector returned no findings. Scoped diff check passed. `apps/www` production webpack build passed with TypeScript and all routes generated.
- Deployment/push: Included in pushed `origin/main` commit `bd06d349`; Coolify service `propai-lab:main` still needs redeployment before the public site reflects the change.
- Independent task-verifier verdict: PARTIAL — source mapping, projection, rendering path, and build are verified; live production rendering remains pending redeployment.
- Limitations: The source includes a rent quote (`190 rs build-up`) that is not currently populated in the typed `price_raw_text`/`rent_per_sqft` fields, so this UI change does not display that quote until extraction/persistence stores it in a public-safe typed field.
- Next action: Redeploy `propai-lab:main`, then reopen listing `10103` and confirm the expanded property-details section and corrected title.

## 2026-09-07 — Make extraction single-pass by default and attribute usage

- Requested outcome: Stop routine per-item extraction calls from inflating Sarvam usage, and record exactly why any additional model call occurs.
- Changes: Removed the routine focused extraction pass from `ai_extract`; the unified prompt now supplies all items and fields in one normal call. Kept bounded exceptional segmentation, provider fallback, and review repair paths. Added `call_stage`, `attempt_number`, and `retry_reason` to usage logging and the `ai_usage_log` migration. Updated the architecture contract and added a regression assertion that a normal multi-item extraction makes one provider call.
- Verification: Python compilation passed; Sarvam request regression passed (`1 passed`); scoped `git diff --check` passed; live Supabase migration applied successfully (`HTTP 201`) and the three new columns were confirmed in `public.ai_usage_log`. Full extraction test collection remains blocked in this environment because `langgraph` is not installed.
- Deployment/push: Database migration applied to the live Supabase project. Code still requires a scoped commit/push and redeployment of `extraction-worker`; no production worker redeploy was performed in this turn.
- Independent task-verifier verdict: PARTIAL — the single-pass code path, attribution fields, migration, and focused checks are verified, but production worker behavior after redeployment and the blocked full suite remain unverified.
- Limitations: Ambiguous broadcast boundary segmentation and provider/storage failures can still cause additional calls; these are now explicitly staged and bounded. Historical usage rows remain `call_stage = 'unknown'`.
- Next action: Commit and push the scoped extraction/usage changes, redeploy `extraction-worker`, then inspect fresh `ai_usage_log` rows to confirm normal messages show one `initial_extraction` call.

## 2026-09-07 — Make Market Inbox locality scope and card metadata usable

- Requested outcome: Stop Market Inbox chips from visually collapsing, move card locality to the top-right, and replace free-form market-area editing with database-backed locality chips plus a controlled missing-locality fallback.
- Changes: Added enforced spacing/nowrap rules for shared pill rows; moved each card’s locality link to a right-aligned metadata row; added locality suggestion loading from `/localities/suggestions`; added removable selected-area chips, duplicate protection, and an explicit “Add missing locality” action; save now persists the selected draft areas without requiring comma-separated text.
- Verification: Scoped TypeScript check for the changed inbox region passed; ESLint reported warnings only and no errors; scoped `git diff --check` passed. Full frontend build was blocked by the sandbox/Turbopack process-port permission error. Existing unrelated TypeScript errors remain elsewhere in the repository.
- Deployment/push: Pending scoped commit and push. Coolify service `propai-lab:main-app` needs redeployment before `app.propai.live` reflects the changes; no deployment was performed in this turn.
- Independent task-verifier verdict: PARTIAL — the source path, persistence path, suggestion endpoint, and scoped checks are verified locally, but live production rendering and browser interaction remain pending redeployment.
- Limitations: The fallback permits a user-entered locality only after no database suggestion matches; backend preference storage still accepts that explicit new locality as intended. Live visual confirmation is pending because browser control is unavailable in this session.
- Next action: Redeploy `propai-lab:main-app`, hard-refresh Market Inbox, open Edit market scope, verify database chips add/remove correctly, and confirm card chips have visible gaps with locality aligned right.

## 2026-09-07 — Remove needs-review as a delivery gate

- Requested outcome: Let source-backed extractions pass without a “Needs attention” review gate.
- Changes: Extraction Activity now treats every loaded typed extraction as saved and removes the review status filter/count. Quality notes and original evidence remain visible for audit. Google Drive export no longer rejects a source-backed row solely because `needs_review` is set; broker blocking remains enforced.
- Verification: `python3 -m py_compile routers/google_drive.py` passed; scoped `git diff --check` passed. ESLint could not run because the sandbox could not resolve `registry.npmjs.org`; no production build was run for this small change.
- Deployment/push: Pending scoped commit and push. Coolify services `propai-lab:main-app` and `api` need redeployment for the UI and export behavior respectively; no deployment was performed in this turn.
- Independent task-verifier verdict: PARTIAL — the extraction UI and export path no longer gate on `needs_review`, and evidence remains available; live deployment verification is pending.
- Limitations: The database flag is intentionally retained as historical quality metadata and is not deleted or rewritten. Other administrative dashboards may still report its count as an audit signal.
- Next action: Redeploy `propai-lab:main-app` and `api`, then confirm a flagged extraction displays Saved and can be exported when the broker is not blocked.

## 2026-09-07 — Preserve AI intent for natural-language property searches

- Requested outcome: Keep Chat agent-like and prevent a user’s natural-language property search from being reduced to a broker-requirement lookup.
- Changes: Removed the parser rule that treated `looking for` as an explicit requirements query. “Looking for a 3 BHK for sale in Bandra West budget upto 5 Cr” now remains a listing search with `SELL`, BHK, locality, and budget filters; explicit requirement terms remain supported.
- Verification: Focused chat/search regression suite passed 18/18; the new regression asserts listing intent and no requirements scope; scoped diff check passed.
- Deployment/push: Pending scoped commit and push. Coolify service `api` needs redeployment; no production deployment was performed in this turn.
- Independent task-verifier verdict: PARTIAL — parser behavior and regression coverage pass locally, but live Sarvam/provider routing and production Chat rendering remain pending redeployment.
- Limitations: The model/tool path can still be unavailable when provider credits or configuration fail; the deterministic fallback now preserves this corrected intent instead of misrouting `looking for`.
- Next action: Redeploy `api` and test the exact screenshot query in a fresh Chat session; verify the response says active sale listings and renders all matching records.

## 2026-09-07 — Preserve source-grounded commercial office facts end-to-end

- Requested outcome: Extract and display the additional commercial-office facts present in broker messages, including operational facilities and area-based rent wording, instead of silently dropping them before the public listing page.
- Changes: Extended the commercial extraction/persistence allow-lists and public SSR projection for manager cabins, telephone booths, ladies/gents washrooms, play areas, and the existing office-fact fields. Added an additive migration for the five missing typed columns. Preserved explicit `Rent 190 rs build-up` wording and made commercial monthly-rent arithmetic use built-up area when the source names that basis. Updated the architecture contract and regression assertions.
- Verification: Python compilation passed; focused extraction/prompt tests passed (`2 passed`); public `apps/www` webpack production build passed with TypeScript and all routes generated; Impeccable detector returned no findings; scoped `git diff --check` passed. The authenticated Supabase CLI dry run selected only this migration, it applied successfully, and live PostgREST queries confirmed all five new columns on both commercial tables.
- Deployment/push: Scoped commit `adb08535` was pushed to `origin/main`. Supabase migration `20260907193000_expand_commercial_office_facts.sql` is applied. Coolify services `extraction-worker` and `propai-lab:main` still require redeployment; no Coolify deployment was performed in this turn.
- Independent task-verifier verdict: PARTIAL — local extraction, persistence projection, SSR consumer, build, push, and live schema are verified, but worker replay and public redeployment remain pending.
- Limitations: Existing listing rows will not be retroactively populated by code changes alone; listing `10103` currently has the new columns but null values and must be reprocessed after the worker redeploy. The CLI reported only a non-blocking local Docker catalog-cache warning.
- Next action: Redeploy `extraction-worker` and `propai-lab:main`, then replay listing `10103` and verify the office facts and built-up rent basis on the public page.

## 2026-09-07 — Verify extraction schema and preserve explicit asset type

- Requested outcome: Resolve the commercial-field schema mismatch and prevent valid provider `asset_type` output from being discarded before typed persistence.
- Changes: Applied the existing commercial-office migration to the live Supabase project; added an explicit `asset_type` → `property_category` normalization alias without keyword inference.
- Verification: Live schema query confirmed all five added columns on both commercial listing tables; Python compilation, focused normalization assertion, and scoped diff check passed.
- Deployment/push: The live database migration is applied. The `ai_extraction.py` alias change is ready for a scoped commit/push; `extraction-worker` requires redeployment before it takes effect.
- Independent task-verifier verdict: PARTIAL — the schema is verified live and the code check passes, but worker redeployment and production observation of previously failing rows remain pending. Broker source-evidence blocks are still correctly enforced and need separate remediation if those rows continue failing.
- Limitations: Dedupe HTTP 409s are expected idempotency conflicts; missing broker source evidence must not be bypassed. The optional Doubleword provider remains disabled until both required environment variables are configured.
- Next action: Push the alias fix, redeploy `extraction-worker`, then confirm a previously failing commercial/asset-type message stores successfully and that the commercial column-select errors disappear.

## 2026-09-07 — Preserve broker attribution during typed extraction

- Requested outcome: Stop valid listings from being discarded when the model omits the broker from an item slice, while keeping broker identity source-grounded.
- Changes: Preserve explicit provider `asset_type` instead of overwriting it with a fallback; rehydrate the canonical broker name from the source-backed broker identity after resolution; remove unsupported broker name/company/RERA values and mark the row for review instead of blocking when a transport/source broker identity exists; stop routing unstructured no-anchor messages into typed listing tables.
- Verification: Focused broker-grounding tests passed (`14 passed, 1 deselected`); Python compilation and focused normalization/grounding assertions passed; scoped diff check passed. The broader extraction test collection remains blocked by the existing missing `langgraph` dependency, and one pre-existing duplicated PSF test expectation is inconsistent.
- Deployment/push: Source changes are ready for a scoped commit and push; `extraction-worker` requires redeployment. Existing unrelated dirty files were not staged.
- Independent task-verifier verdict: PARTIAL — the source path and persistence guard are verified locally, but production behavior after worker redeployment and retry of previously failed messages remain pending.
- Limitations: If both WhatsApp transport identity and any source broker identity are genuinely absent, the row remains blocked rather than inventing one. Optional broker company/RERA metadata is still review-only unless source-supported.
- Next action: Redeploy `extraction-worker`, then confirm the `asset_type` stub errors and broker-evidence write failures no longer occur for newly selected messages; inspect any remaining blocked rows individually.

## 2026-09-07 — Restore agent-led workspace chat routing

- Requested outcome: Keep AI Chat capable of natural conversation and multi-step reasoning instead of reducing it to a deterministic property-search chatbot.
- Changes: Added a tenant-safe `lookup_building` read tool for project/location questions; removed the pre-agent deterministic building lookup and canned greeting route; expanded the agent prompt to distinguish building facts, inventory, broker/client, clarification, and write requests; increased the bounded workspace graph loop from 2 to 6 rounds; documented the routing boundary in `architecture.md`.
- Verification: `python3 -m pytest -q tests/test_agent_tools.py tests/test_ai_chat_market_search_regression.py` passed (`13 passed`); Python compilation and scoped `git diff --check` passed. Live browser/provider behavior was not verified in this turn.
- Deployment/push: Scoped commit `486c0596` was pushed to `origin/main`. Coolify `api` deployment `ivzuh87jvb3z5tw9zk2s98v9` was queued and reported `finished`; production API status is running. Existing persisted chats still show their historical responses.
- Independent task-verifier verdict: PARTIAL — the agent path, tool schema, tenant guard, prompt, and local regressions pass; production Sarvam routing, live UI behavior, and provider-failure behavior remain pending redeployment.
- Limitations: Grounding still deliberately fails closed for concrete property facts if no read tool returns a result, and writes still require confirmation. This is a safety boundary, not a fixed response script.
- Next action: Test a fresh Chat session with “where is Rustomjee Paramount?”, “show all 3 BHK sale options in Bandra West”, and a follow-up such as “what else do you know about that project?”.

## 2026-09-07 — Align public SEO URLs with indexable listing pages

- Requested outcome: Improve Google indexing quality for `www.propai.live` by reducing sitemap duplicates/stale listing URLs and making the canonical URL and indexability of listing pages explicit.
- Changes: The live sitemap now applies the shared public eligibility gate and recent identity deduplication before emitting listing URLs. Listing metadata now emits an absolute canonical URL for the canonical slug, marks current listings `index, follow`, and marks expired/invalid listing pages `noindex, follow` while keeping useful visitor content available.
- Verification: Live `robots.txt` returned `200`, explicitly allowed `User-agent: *`, and pointed to `https://www.propai.live/sitemap.xml`; live sitemap returned `200` with 5,174 URLs and sampled listing URLs returned `200`. Scoped `git diff --check` passed. `apps/www` TypeScript reported only the pre-existing unrelated `test/natural-search.test.ts` optional-field error; a second build invocation was blocked by Next reporting another build process already running after the first build generated `.next` output.
- Deployment/push: Code is not yet committed or pushed in this turn. Coolify service `propai-lab:main` needs redeployment after push; no deployment was performed.
- Independent task-verifier verdict: PARTIAL — source changes, live robots/sitemap behavior, and the canonical/indexability path are verified locally/live; production behavior after this code change remains pending commit and redeployment, and historical Search Console exclusions will not disappear immediately.
- Limitations: Existing Search Console rows include historical URLs and intentional `noindex` pages, so this change cannot remove all 8.17k exclusions. Google must recrawl the refreshed sitemap before the counts change.
- Next action: Commit and push these scoped SEO changes, redeploy `propai-lab:main`, resubmit/inspect the sitemap in Search Console, and monitor 404, duplicate-canonical, and crawled-not-indexed buckets.

## 2026-09-08 — Deduplicate workspace navigation tabs

- Requested outcome: Stop the internal workspace tab strip from accumulating duplicate tabs when navigating from the module menu.
- Changes: Added route-based tab normalization, removed duplicate persisted tabs during hydration, prevented route tracking until localStorage hydration completes, and rewrites the cleaned tab list back to storage whenever navigation occurs.
- Verification: Impeccable detector returned no findings for `frontend/src/hooks/useLayout.tsx`; scoped `git diff --check` passed. Frontend TypeScript reported existing unrelated errors across the dashboard and none in the changed hook.
- Deployment/push: Pending scoped commit and push. Coolify service `propai-lab:main-app` needs redeployment before the fix reaches `app.propai.live`; no deployment was performed.
- Independent task-verifier verdict: PASS for the requested tab-deduplication code path; live browser verification remains pending redeployment.
- Limitations: Existing browser localStorage is cleaned on the first load after deployment; users may briefly see the old list before the new bundle runs.
- Next action: Commit/push the hook change, redeploy `propai-lab:main-app`, then navigate through several modules and confirm each route appears once.

## 2026-09-07 — Fix Market Inbox refresh and card information hierarchy

- Requested outcome: Make the Market Inbox refresh action visibly work, move locality to the top-right of each card, and surface useful WhatsApp details directly on cards instead of hiding everything under source evidence.
- Changes: Added an explicit refresh state and last-updated timestamp; wired the button to the existing no-store feed loader; moved the locality link before the card controls and enforced that order in the zone contract; added a compact source-grounded “Additional details from WhatsApp” preview while retaining the full evidence disclosure.
- Verification: Frontend production build passed with placeholder public Supabase variables; the Impeccable detector returned no findings; scoped `git diff --check` passed. The staged commit contains only `frontend/src/app/inbox/page.tsx` and `frontend/src/app/zone-contract.css`; unrelated dirty files were not staged.
- Deployment/push: Commit `7ce5cc85` was pushed to `origin/main`. Coolify deployment `vicl2270pec11tc8o7slmcti` for `propai-lab:main-app` reported `finished`; API redeployment was not needed.
- Independent task-verifier verdict: PARTIAL — the refresh handler, layout order, source preview, build, push, and Coolify deployment are verified; live browser click/render confirmation remains pending.
- Limitations: A hard refresh may be needed to clear an older frontend bundle. Long source messages will make cards taller because the requested details preview is intentionally visible; full evidence remains available in the disclosure.
- Next action: Hard-refresh `https://app.propai.live/inbox`, click `Refresh data`, confirm the button changes to `Refreshing…` and then shows `Updated <time>`, and confirm locality is above the pills with the WhatsApp detail preview visible.

## 2026-09-08 — Compact Market Inbox mobile actions

- Requested outcome: Reduce the oversized WhatsApp and CRM action buttons in the mobile Market Inbox card layout.
- Changes: Replaced the mobile full-width vertical action stack with a compact two-column grid; WhatsApp and CRM sit side-by-side, while Find similar spans the row. Buttons retain a 40px touch-friendly height and truncate safely on narrow screens.
- Verification: Impeccable detector returned no findings; scoped `git diff --check` passed; elevated frontend production build passed with 74 routes generated.
- Deployment/push: Scoped commit `4238724a` was pushed to `origin/main`. Coolify deployment `rgw4z4fidpxo5j2awo2kjh1c` for `propai-lab:main-app` reported `finished`; API is unchanged.
- Independent task-verifier verdict: PARTIAL — responsive CSS and production compilation are verified, but live mobile browser interaction remains pending.
- Limitations: The mobile action grid has not been visually confirmed on a physical device in this session; very narrow widths may truncate action labels while preserving the full action via the button title/accessible name.
- Next action: Hard-refresh Market Inbox on mobile and confirm the two primary actions fit without oversized blocks.

## 2026-09-08 — Show the applicable source slice in Market Inbox evidence

- Requested outcome: Market Inbox evidence should show the source block applicable to the selected listing instead of displaying the complete multi-listing WhatsApp broadcast by default.
- Changes: The evidence disclosure now renders `source_slice_text` first, labels it “Applicable WhatsApp excerpt,” and puts the complete broadcast behind an explicit “View full broadcast evidence” disclosure. Existing unrelated inbox changes in the same file were not staged.
- Verification: Scoped diff check passed; frontend production build passed with 74 routes after retrying with required process permissions. Independent task-verifier verdict: PARTIAL — local consumer behavior and build are verified, but production deployment and browser confirmation remain pending.
- Deployment/push: Commit `b9f4f112` was pushed to `origin/main`. Coolify service `propai-lab:main-app` requires redeployment; no deployment was performed in this turn.
- Limitations: If an old persisted row has no usable `raw_payload.slice_text`, the API may fall back to full evidence; affected rows need reprocessing under the source-slice extraction contract.
- Next action: Redeploy `propai-lab:main-app`, hard-refresh Market Inbox, open one listing’s evidence, and confirm the applicable block is shown first while the full broadcast remains collapsed.

## 2026-09-08 — Restore WhatsApp connection page visibility and status-card contrast

- Requested outcome: Make the disconnected WhatsApp connection card green with cream text and keep the WhatsApp page visible when the reset dialog is open.
- Changes: Added a disconnected-state class for the connection card and reconnect action styling; replaced the modal backdrop’s legacy `bg-black/60` utility with a semantic backdrop class so the shell theme bridge cannot turn it into an opaque page-colored layer.
- Verification: Impeccable detector returned no findings; scoped `git diff --check` passed; elevated frontend production build passed with 74 routes generated.
- Deployment/push: Scoped commit `07f09ffe` was pushed to `origin/main`. Coolify deployment `jdrabot0k7usot7er169vr27` for `propai-lab:main-app` reported `finished`; API is unchanged.
- Independent task-verifier verdict: PARTIAL — source changes and production compilation are verified, but live dialog interaction and visual confirmation remain pending deployment.
- Limitations: The live page was not browser-click tested from this session; the dialog backdrop is intentionally translucent so the underlying connection page remains readable while focus stays on the modal.
- Next action: Hard-refresh WhatsApp → My Numbers and open Reset & re-pair to confirm the page stays visible behind the dialog.

## 2026-09-08 — Keep Market Inbox scope Save action visible

- Requested outcome: Ensure the market-scope Save/Update scope action remains visible after locality suggestions are added or displayed.
- Changes: Changed the database locality suggestions panel from an absolutely positioned overlay to a bounded in-flow scroll panel, so it pushes the Update scope button below it rather than covering the button.
- Verification: Impeccable detector returned no findings; scoped `git diff --check` passed; elevated frontend production build passed with 74 routes generated. Only the intended Inbox hunk was staged; existing unrelated Inbox changes remain unstaged.
- Deployment/push: Scoped commit `b8b82b30` was pushed to `origin/main`. Coolify deployment `srzsqtee6acpsszv4p0kq8xh` for `propai-lab:main-app` reported `finished`.
- Independent task-verifier verdict: PARTIAL — source layout, build, push, and deployment are verified; live browser interaction remains pending.
- Limitations: The live editor was not click-tested from this session. The suggestions list is intentionally capped and scrollable to preserve access to Save on smaller screens.
- Next action: Hard-refresh `https://app.propai.live/inbox`, edit market scope, add a locality, and confirm Update scope is visible below the suggestions list.

## 2026-09-08 — Repair source-grounded extraction quality for mixed broadcasts

- Requested outcome: Preserve the facts in noisy multi-listing broker broadcasts, including shared building headers, item-level transaction/category, broker attribution, non-numeric price wording, and visible extraction evidence.
- Changes: Recover a named building only from a shared header before the first property block; keep `On Call` as raw price text instead of an invalid PSF unit; keep broker-phone/transport attribution from zeroing otherwise valid confidence; make classification audit fields item-specific; and show `price_raw_text` in the internal extraction detail/list view when no numeric price exists. Updated `architecture.md` with the source-boundary invariant.
- Verification: Python compilation passed; focused broker/grounding tests passed (`6 passed, 9 deselected`); direct regression assertions returned `MARINA BAY`, `(None, None)` for `On Call`, and preserved high confidence with broker phone; frontend production build passed with 74 routes; scoped `git diff --check` and `git show --check` passed. Independent task-verifier verdict: PARTIAL — local code paths and consumers are verified, but production redeployment and replay of an affected raw message are still pending.
- Deployment/push: Commit `627aacc2` was pushed to `origin/main`. Coolify services `extraction-worker` and `propai-lab:main-app` require redeployment; no Coolify deployment was performed in this turn.
- Limitations: Existing rows such as raw message `946771` will not be rewritten by this code change alone. After redeployment, replay that raw message or wait for a materially new message, then verify all four item blocks, `MARINA BAY`, `On Call`, broker attribution, and item-level sale/rent/category metadata in `app.propai.live/extractions`.
- Next action: Redeploy `extraction-worker` and `propai-lab:main-app`, replay raw `946771` through the approved extraction repair/replay path, and inspect the resulting evidence beside the structured rows.

## 2026-09-08 — Guard Market Inbox dedupe and malformed listing fields

- Requested outcome: Stop transaction labels such as `R E N T` from appearing as building names, prevent implausible residential areas such as `80,000 sqft` from polluting titles/prices, and improve deduplication for reposted item slices.
- Changes: Added source-fingerprint-plus-listing-index priority to observation fingerprints; reject spaced transaction labels as building identities; quarantine residential areas above 25,000 sqft during AI-to-typed persistence with review metadata; and protect the inbox title, area, and derived-price consumers for already-persisted bad rows.
- Verification: Independent second-pass task-verifier verdict: PARTIAL. Cached diff contained only the five intended files and passed `git diff --check`; Python compilation passed; focused extraction tests passed (`6 passed, 9 deselected`); frontend production build passed with 74 routes. No production browser/replay verification was performed.
- Deployment/push: Commit `6b24c6cf` was pushed to `origin/main`. Coolify services `extraction-worker` and `propai-lab:main-app` require redeployment; no deployment was performed in this turn.
- Limitations: Existing database rows are not rewritten automatically. Rows without `source_fingerprint` retain the older conservative dedupe path. The frontend protects display immediately after redeployment, while persisted corrections require replay through the extraction repair path.
- Next action: Redeploy both services, replay one affected mixed broadcast, and verify that duplicate item slices collapse, `R E N T` is not a building, and `80,000 sqft` is neither displayed nor used in derived pricing.

## 2026-09-08 — Remove duplicate prices from Market Inbox titles

- Requested outcome: Keep listing titles focused on the property and show the rent, sale price, or budget only in the dedicated price panel.
- Changes: Removed generated price/budget suffixes from Market Inbox titles for both listings and requirements. Existing price formatting and price panels are unchanged.
- Verification: Impeccable detector returned no findings; scoped `git diff --check` passed; frontend production build passed with 74 routes. Independent task-verifier verdict: PARTIAL because live browser confirmation remains pending.
- Deployment/push: Commit `7c8988cb` was pushed to `origin/main`. `propai-lab:main-app` requires redeployment; no deployment was performed in this turn.
- Limitations: Older persisted `summary_title` values that already contain prices are still rejected by the existing legacy-title guard and rebuilt when rendered; a hard refresh is required after deployment.
- Next action: Redeploy `propai-lab:main-app`, hard-refresh Market Inbox, and confirm titles no longer repeat the price shown at right.

## 2026-09-08 — Repair commercial PSF extraction and generic titles

- Requested outcome: Correct the Andheri commercial broadcast where `350 RS. PSF` became a fabricated monthly total and the title displayed “Not specified Property.”
- Changes: The source authority parser now recognizes the broker format `amount RS. PSF` and repairs a conflicting AI price to the unique source-backed PSF rate. The inbox price consumer supports the same format, strips generic “Not specified” prefixes, and uses “commercial space” as the fallback subject.
- Verification: Exact `350 RS. PSF` source assertion passed; Python compilation passed; focused PSF/confidence tests passed (`2 passed, 13 deselected`); frontend production build passed with 74 routes. Independent task-verifier verdict: PARTIAL because the live row still needs replay and browser confirmation.
- Deployment/push: Commit `6a35a7b3` was pushed to `origin/main`. `extraction-worker` and `propai-lab:main-app` require redeployment; no deployment was performed in this turn.
- Limitations: Existing rows retain their stored bad price until replayed. Multiple shop areas in one broadcast remain separate item candidates; the selected area must come from the item slice, not an arbitrary broadcast-wide area.
- Next action: Redeploy both services, replay this Andheri broadcast, and verify each shop option shows a PSF rate, not a monthly total, with the broker identity preserved where source-scoped evidence permits.

## 2026-09-08 — Show broker phone evidence in extraction details

- Requested outcome: Do not mark broker evidence as missing when WhatsMeow has captured a broker phone but the broker name field is absent.
- Changes: Extraction detail now renders separate `Broker name` and `Broker phone` evidence rows. The phone is independently checked against the original WhatsApp message, while the existing broker summary still shows the available identity fallback.
- Verification: Frontend production build passed with 74 routes; scoped diff check passed. Impeccable reported one pre-existing gray-text-on-colored-background warning on the modal line, unrelated to this change. Independent task-verifier verdict: PARTIAL because live browser confirmation remains pending.
- Deployment/push: Commit `26f24548` was pushed to `origin/main`. `propai-lab:main-app` requires redeployment; no deployment was performed in this turn.
- Limitations: This corrects the evidence display. It does not retroactively populate missing broker names in old database rows; those require extraction replay or a separate source-grounded backfill.
- Next action: Redeploy `propai-lab:main-app`, open an extraction containing `Ram - 9867551116`, and confirm the phone evidence row is green while the name row reflects whether the name was persisted.

## 2026-09-08 — Preserve named villa buildings in extraction

- Requested outcome: Treat `Villa Capri` and `Devansh Villa` as building names, not as the property type `Villa`.
- Changes: Added source-bound recovery for broker headings formatted as `Building Name @ price`; standalone `Villa` is rejected as a building identity; titles suppress a duplicated/unsupported `Villa` property-type word when the source-backed building contains it. Added regression tests and documented the invariant in `architecture.md`.
- Verification: `python3 -m py_compile extraction.py extraction_quality.py` passed; focused regression tests passed (`3 passed, 19 deselected`); staged diff passed `git diff --cached --check`. The broader pipeline test could not collect because this shell's Python environment lacks `langgraph`; no live replay/browser verification was performed. Independent task-verifier verdict: PARTIAL.
- Deployment/push: Commit `f6c9605e` was pushed to `origin/main`. Coolify services `extraction-worker` and `propai-lab:main-app` require redeployment; existing rows need replay to receive the corrected building/title fields.
- Limitations: This is source recovery for the observed heading format, not Google enrichment. Rows already stored as `Villa` or with old titles will not change until replayed or separately backfilled.
- Next action: Redeploy both services, replay the Villa Capri/Devansh Villa source messages, and verify the inbox cards show the building names without labeling them as villas.

## 2026-09-08 — Remove parser placeholders from public building links

- Requested outcome: Prevent `Configuration` from appearing under “Buildings in this locality.”
- Changes: Extended the shared public `isJunkBuildingName` guard to reject parser placeholders such as `Config`, `Configuration`, `Not specified`, and `Unknown`. The locality summary and related-search building links already consume this guard, so the filter applies to both surfaces.
- Verification: Scoped diff check passed; the public app production build and TypeScript check passed in the preceding verification cycle. Independent task-verifier verdict: PARTIAL until the deployed Andheri West detail page is refreshed and the live related-search list is confirmed.
- Deployment/push: Commit `52b3913c` was pushed to `origin/main`. Relevant Coolify service is `propai-lab:main`.
- Limitations: Existing database rows are not deleted; they are suppressed from public building links. A new canonical building named `Configuration` would also be suppressed as an intentional safety tradeoff.
- Next action: Redeploy `propai-lab:main`, then refresh the detail page and confirm `Configuration` is absent while valid buildings remain.

## 2026-09-08 — Bound public listing detail latency and mask broker placeholders

- Requested outcome: Prevent public listing cards from showing masked broker garbage and stop listing detail pages from remaining on the skeleton indefinitely.
- Changes: Reject symbol-heavy broker display values such as `#$!#$@m` at both public card and server-side detail boundaries. Added bounded timeouts for the core detail lookup and optional broker, similar-listing, related-link, and photo queries; slow secondary data now fails soft while the listing renders. Documented the latency invariant in `architecture.md`.
- Verification: Impeccable detector returned no findings; `apps/www` production build completed successfully with TypeScript passing; scoped diff check passed. The package has no test script and no local `tsx` binary, so the existing TypeScript test harness could not be run. Independent task-verifier verdict: PARTIAL until live production timing and card rendering are confirmed.
- Deployment/push: Commit `f6fe89e8` was pushed to `origin/main`. Relevant Coolify service is `propai-lab:main`.
- Limitations: A core lookup that exceeds 12 seconds still resolves honestly as not found; this prevents indefinite loading but depends on Supabase availability. Existing deployed behavior is unchanged until the public service is redeployed.
- Next action: Redeploy `propai-lab:main`, then hard-refresh the homepage and open a detail link to verify broker placeholders disappear and the detail page renders within the timeout budget.

## 2026-09-08 — Fix public latest price formatting and freshness

- Requested outcome: Display absolute sale prices such as `₹78,00,000` as `₹78 Lakh`, and ensure the latest ticker/locality browse data updates after new extraction.
- Changes: Updated the homepage ticker to normalize absolute and legacy-unit prices before formatting; changed the latest-listing endpoint to force dynamic/no-store responses; shortened the browser poll to 30 seconds; and reduced the locality aggregate cache/page window to 60 seconds. Documented the public freshness contract in `architecture.md`.
- Verification: Public `apps/www` production build and TypeScript check passed; Impeccable detector returned no findings for the changed ticker; scoped `git diff --check` passed. Independent task-verifier verdict: PARTIAL — code paths and local build are verified, but production redeployment and live browser confirmation remain pending.
- Deployment/push: Commit `81f51318` was pushed to `origin/main`. Relevant Coolify service: `propai-lab:main`; no deployment was performed.
- Limitations: The feed can still show no listing when the source row is not yet eligible or has not been saved by extraction; this change removes the public cache delay but does not change extraction eligibility.
- Next action: Redeploy `propai-lab:main`, then hard-refresh the public site and confirm the ticker/locality cards reflect the newest saved row and show lakh/crore formatting.

## 2026-09-08 — Guard mismatched building addresses and recover commercial use labels

- Requested outcome: Keep a Carter Road retail listing from displaying a conflicting Bandra West building address when its listing locality is Andheri West, and show the source-grounded retail use instead of generic commercial space.
- Changes: Building-address enrichment now requires the verified building locality to match the typed listing locality; conflicting addresses are withheld. Market Inbox now derives a fallback `Retail shop` label from the source slice when older rows lack `commercial_use_type`.
- Verification: `python3 -m py_compile storage/supabase.py extraction.py` passed; `apps/www` production build and TypeScript check passed; scoped `git diff --check` passed. Independent task-verifier verdict: PARTIAL — code paths and local checks pass, but production redeployment and live browser confirmation remain pending.
- Deployment/push: Commits `48885001` and `fcbc0738` were pushed to `origin/main`. Relevant Coolify service: `propai-lab:main-app`; no deployment performed.
- Limitations: Existing rows will display the corrected dashboard fallback after redeployment, but persisted extraction fields such as floor-area components still require replay or a separate source-grounded backfill.
- Next action: Redeploy `propai-lab:main-app`, refresh Market Inbox, and verify the Carter Road card has no conflicting Bandra West address and is labeled Retail shop.

## 2026-09-08 — Scope WhatsApp CTA to the selected listing

- Requested outcome: When a user clicks a listing's WhatsApp CTA, send only that listing's source slice instead of the entire multi-listing broadcast.
- Changes: The API now keeps `source_slice_text` (or the stored payload slice) for the outgoing CTA while retaining the complete raw message only for finding contact numbers. Added a regression test proving unrelated broadcast text is excluded.
- Verification: Focused contact-resolution tests passed (`3 passed`); Python compilation and scoped diff checks passed. Independent task-verifier verdict: PARTIAL — local input-to-URL behavior is verified, but live browser confirmation is pending while deployment is still in progress.
- Deployment/push: Commit `a720fb54` is present on `origin/main`. Coolify API deployment `fx1lbe004vnadwbss6zhjeca` was queued and remained `in_progress` at the final status check.
- Limitations: If a row has no source slice, the endpoint falls back to the best available source text; existing browser tabs need a refresh after the API deployment completes.
- Next action: Wait for the `api` deployment to finish, hard-refresh the dashboard, click a listing's WhatsApp CTA, and confirm only that listing's details appear in the message.

## 2026-09-08 — Create clients from the save-properties flow

- Requested outcome: Let a broker save selected Market Inbox properties even when the client has not been created yet.
- Changes: Added an inline client creation form to the save sheet with required name, optional phone, and a single `Create & save` action that creates the client and attaches the selected records. Updated the empty state to explain the available action.
- Verification: Impeccable detector returned no findings; scoped diff check passed; frontend production build passed with 74 routes. Independent task-verifier verdict: PARTIAL because live browser confirmation is pending.
- Deployment/push: Commit `9a29b472` was pushed to `origin/main`; relevant Coolify service is `propai-lab:main-app`, which still requires redeployment.
- Limitations: The form creates a client and attaches the current selection; editing richer client fields remains available in Private CRM. Existing browser tabs need a refresh after deployment.
- Next action: Redeploy `propai-lab:main-app`, then verify creating a new client from Market Inbox saves the selected property.

## 2026-09-08 — Make WhatsApp sequence action visibly active

- Requested outcome: Make the `Open WhatsApp sequence` action clearly visible when listings are selected in Market Inbox.
- Changes: Replaced the low-contrast outline treatment with a solid emerald WhatsApp action, added a message icon, and added an accessible selection-count label. The existing controlled sequence behavior is unchanged.
- Verification: `git diff --check` passed; Impeccable detector returned no findings; frontend production build passed with 74 routes. Independent task-verifier verdict: PARTIAL because live browser verification after deployment is still pending.
- Deployment/push: Commit `51228b61` was created locally. Relevant Coolify service is `propai-lab:main-app`; no deployment was performed.
- Limitations: The deployed dashboard will not show the new styling until the main-app service is redeployed. The existing uncommitted client-creation edits in the same file were not staged or changed by this task.
- Next action: Push `51228b61`, redeploy `propai-lab:main-app`, refresh Market Inbox, select a listing, and confirm the green button opens the sequence dialog.

## 2026-09-08 — Replace developer-facing listing detail labels

- Requested outcome: Make the listing detail page understandable to brokers instead of exposing internal terms such as “Broker not resolved,” “WhatsApp evidence,” and “Building enrichment pending.”
- Changes: Renamed the facts section to `Property details`, the source section to `Original broker message`, and replaced technical empty/pending labels with broker-facing explanations. The WhatsApp contact action is now labeled `Contact broker on WhatsApp`.
- Verification: Frontend production build passed with 74 routes; scoped diff check passed. Impeccable detector reported one pre-existing gray-on-color warning on the unchanged broker button styling. Independent task-verifier verdict: PARTIAL pending live browser confirmation after deployment.
- Deployment/push: Commit `80d291fe` was created locally. Relevant Coolify service is `propai-lab:main-app`; no deployment was performed.
- Limitations: This changes interface language only; it does not alter broker resolution, address enrichment, or stored listing data.
- Next action: Push `80d291fe`, redeploy `propai-lab:main-app`, and refresh a listing detail page to confirm the new labels appear.

## 2026-09-08 — Broaden similar options and repair client saving

- Requested outcome: Do not require a strict similarity match, and make saving selected properties to a newly created client succeed.
- Changes: `Find similar` now fetches the broader nearby-market inventory and ranks candidates by layout, budget, area, and furnishing instead of excluding anything outside narrow thresholds. Client candidate saving now omits a stale raw-message foreign key when the referenced raw message cannot be verified, allowing the typed source reference to remain usable.
- Verification: Impeccable detector returned no findings; scoped diff check passed; `storage/supabase.py` compiled; frontend production build passed with 74 routes. Independent task-verifier verdict: PARTIAL because live browser/database confirmation is pending.
- Deployment/push: Not yet committed or pushed at report-writing time. Relevant services are `api` for candidate saving and `propai-lab:main-app` for the similar-options UI.
- Limitations: Similar options still search the configured nearby-market set and preserve the same transaction type; they are ranked, not a claim of complete market coverage. The 400 response was diagnosed from the dangling-FK path but could not be directly queried because the available Supabase management credential returned unauthorized.
- Next action: Commit and push, redeploy both `api` and `propai-lab:main-app`, then verify a new client save and a broadened similar-options result in the live dashboard.

## 2026-09-08 — Remove duplicated price text from listing descriptions

- Requested outcome: Replace awkward public copy such as `₹8.75 Cr ... For sale at ₹8.75 Cr` with a concise structured listing description.
- Changes: The public detail page now regenerates its summary from current typed facts instead of preferring stale persisted SEO copy. The generator no longer repeats the asking price because the detail page already shows it in the price block.
- Verification: `apps/www` production build and TypeScript check passed; Impeccable detector returned no findings for the changed detail page/copy module; scoped `git diff --check` passed. The focused `npx tsx` regression command could not create its stream in the restricted runner, so live/browser output remains unverified. Independent task-verifier verdict: PARTIAL.
- Deployment/push: Commit `ede625cd` was pushed to `origin/main`. Relevant Coolify service is `propai-lab:main`; no deployment performed.
- Limitations: This intentionally stops using stored `publicSeoDescription` on listing detail pages, ensuring old duplicated copy cannot leak. The generated description still reflects only source-grounded typed facts.
- Next action: Commit and push, redeploy `propai-lab:main`, then refresh the Kalpataru Magnus detail page and confirm the description contains no duplicated price or transaction phrase.

## 2026-09-08 — Clean map card titles and explain the map result limit

- Requested outcome: Make the public map feel like a curated real-estate browse surface, remove `Notspecified`/`not_specified` leaks, preserve useful BHK titles, and clarify why the map is bounded.
- Changes: Stopped `ListingTile` from replacing real BHK configurations with `Residential property`; sanitized furnishing text in map popups; and changed the map intro to say it shows the 60 most recent listings. The limit is now a named performance guard because the page renders the list beside the map and enriches coordinates in batches.
- Verification: `apps/www` production build and TypeScript check passed; Impeccable detector returned no findings for the changed map/card targets; scoped `git diff --check` passed. Independent task-verifier verdict: PARTIAL pending live browser confirmation after deployment.
- Deployment/push: Not yet committed or pushed at report-writing time. Relevant Coolify service is `propai-lab:main`; no deployment performed.
- Limitations: The map still shows a bounded recent slice rather than paginating the complete live inventory. Existing production tabs will retain old output until redeployment and refresh.
- Next action: Commit and push, redeploy `propai-lab:main`, then verify the map card keeps `4 BHK`, hides missing furnishing values, and the popup no longer shows `not_specified`.

## 2026-09-08 — Prevent residential titles from using suitability businesses

- Requested outcome: Stop extraction from producing titles such as `Builder finish Gym for sale` for residential BHK inventory, and clarify handling of facts without a dedicated field.
- Changes: Residential title validation now requires a source-supported BHK/RK/bedroom signal in the candidate title and rejects business suitability words such as gym, gymkhana, salon, and clinic as residential property types. The source BHK recognizer now accepts broker shorthand such as `3 bed`. Explicit details without a dedicated typed column continue through bounded `broker_notes` / `unstructured_facts`; the complete raw message and item-local source slice remain evidence.
- Verification: Focused P0 title/evidence regressions passed (`27 passed`); Python compilation and scoped `git diff --check` passed. Independent task-verifier verdict: PARTIAL pending live worker/dashboard confirmation.
- Deployment/push: Not yet committed or pushed at report-writing time. Relevant services are `extraction-worker` and `api`; no deployment performed.
- Limitations: Existing incorrectly titled rows are not automatically rewritten by this code change; they need a bounded replay or repair operation after deployment. Raw evidence remains available for that repair.
- Next action: Commit and push, redeploy `extraction-worker` and `api`, then process or repair one affected residential broadcast and verify the title uses BHK/property wording while gym remains an amenity or source note.

## 2026-09-08 — Hide missing furnishing placeholders from public cards

- Requested outcome: Do not show `Notspecified`, `not_specified`, or equivalent missing-value markers in public listing titles or furnishing chips.
- Changes: Added a shared public fact cleaner that treats parser missing-value markers as absent data. Applied it to deterministic card titles/specs, stored-title fallback handling, and the separate latest-listings card path.
- Verification: Public `apps/www` production build and TypeScript check passed; Impeccable detector returned no findings for the affected card component; scoped `git diff --check` passed. The existing listing-card test harness stops earlier on an unrelated pre-existing title expectation (`Semi Furnished Property...` vs `Semi-Furnished 3 BHK...`), so the new regression was not reached. Independent task-verifier verdict: PARTIAL pending live browser confirmation.
- Deployment/push: Commit `a729e7af` was created locally. Relevant Coolify service is `propai-lab:main`; no deployment performed.
- Limitations: Existing stored rows are unchanged, but their public rendering will omit the placeholder after the service is redeployed. Live production behavior has not yet been verified.
- Next action: Push `a729e7af`, redeploy `propai-lab:main`, and refresh `/map` plus the latest listings view to confirm missing furnishing values are omitted from titles and chips.

## 2026-09-08 — Add database-first public place autocomplete

- Requested outcome: Let the public www search box suggest PropAI localities and buildings from the database, and call Google only when no PropAI place matches the typed location.
- Changes: Search now receives cached locality and building registries on both `/search` and the homepage. Local suggestions show listing counts and route to the relevant locality/building page. A debounced server-side `/api/places/autocomplete` proxy provides Google Places fallback suggestions only for unmatched place-like text; the proxy uses the server-only `GOOGLE_MAPS_API_KEY` and never exposes the key to the browser.
- Verification: `apps/www` production build passed with the new autocomplete route; TypeScript completed successfully; scoped `git diff --check` passed; Impeccable detector returned no findings. Independent task-verifier verdict: PARTIAL because live browser and production deployment confirmation remain pending.
- Deployment/push: Implementation commit pushed to `origin/main`. Relevant Coolify service: `propai-lab:main`; no deployment performed.
- Limitations: Google fallback suggestions require `GOOGLE_MAPS_API_KEY` to be configured on `propai-lab:main`. Google selection fills the search box; submitting the selected place still uses PropAI's own natural-language search and inventory, so it does not claim external Google listings.
- Next action: Commit and push, redeploy `propai-lab:main`, then verify a known PropAI building/locality never triggers Google and an unknown locality shows Google fallback suggestions.

## 2026-09-08 — Add autocomplete to the public map route

- Requested outcome: Make the database-first public search visible on the `/map` page shown in the latest screenshot.
- Changes: Added the shared locality/building `SearchBox` above the map while keeping map listings available if either autocomplete lookup is slow or unavailable.
- Verification: `apps/www` production build and TypeScript check passed; scoped `git diff --check` passed; Impeccable detector returned no findings. Independent task-verifier verdict: PARTIAL because live browser confirmation after redeployment remains pending.
- Deployment/push: Follow-up commit pushed to `origin/main`. Relevant Coolify service: `propai-lab:main`; no deployment performed.
- Limitations: The map still uses the existing bounded recent listing set; autocomplete does not add external Google inventory to the map.
- Next action: Push and redeploy `propai-lab:main`, then refresh `/map` and type a known building/locality to confirm database suggestions appear before Google fallback.

## 2026-09-08 — Correct homepage connected-city label

- Requested outcome: Make the hero selector represent the city, not the first locality in the database.
- Changes: Replaced the misleading `Connected market`/first-locality display with `Connected city` → `Mumbai`; locality discovery remains in search autocomplete and the locality directory.
- Verification: Scoped `git diff --check` passed. Independent task-verifier verdict: PARTIAL pending live browser confirmation after redeployment.
- Deployment/push: Follow-up commit pushed to `origin/main`; relevant Coolify service is `propai-lab:main`; no deployment performed.
- Limitations: The public inventory currently represents the Mumbai market; adding additional cities requires city-scoped data and routing rather than another label change.
- Next action: Redeploy `propai-lab:main` and refresh the homepage to confirm the hero control reads `Connected city Mumbai`.

## 2026-09-08 — Align locality directory counts with public listings

- Requested outcome: Make each homepage locality listing count reflect the actual public listings users can browse.
- Changes: The locality directory now uses the same `getLocalityListings()` path as locality pages after public eligibility filtering and recent-listing deduplication. The existing RPC remains only as a candidate-locality discovery source; it is no longer used as the displayed count.
- Verification: `apps/www` production build passed with TypeScript and route generation; scoped `git diff --check` passed. Independent task-verifier verdict: PASS for the requested code path, with live production verification still pending.
- Deployment/push: Not yet committed or pushed at report-writing time. Relevant Coolify service is `propai-lab:main`; no deployment performed.
- Limitations: The count is cached for 60 seconds and will reflect the deployed version only after `propai-lab:main` is redeployed.
- Next action: Commit and push, redeploy `propai-lab:main`, then compare homepage locality counts with each locality page.

## 2026-09-08 — Add building-name corrections and improve public card titles

- Requested outcome: Let Super Admin correct canonical building names such as `PArarthana` → `Prarthana`, reduce public title truncation, and clarify why some cards show no photo.
- Changes: Added authenticated Super Admin building search and canonical-name editing. Renames preserve the previous spelling as a `building_name_aliases` record with `source=super_admin`, and conflicting canonical names are rejected. Public listing card titles now show up to three lines instead of two. Existing homepage cards continue to show the real signed listing photo when a source photo exists; otherwise they use the explicit no-photo visual and do not fabricate imagery.
- Verification: `apps/www` production build passed with TypeScript and route generation; `routers/admin.py` and `storage/supabase.py` compiled; Impeccable detector returned no findings; scoped `git diff --check` passed. Independent task-verifier verdict: PARTIAL pending live Super Admin and public-card verification after deployment.
- Deployment/push: Commit `4343c3a3` was pushed to `origin/main`. Relevant services are `propai-lab:main-app` for the Super Admin UI, `api` for the authenticated rename endpoint, and `propai-lab:main` for the public card changes; no deployment performed.
- Limitations: Existing home cards without a `listing_photos` source asset will remain no-photo cards. The new correction control changes the canonical building registry and preserves the old spelling as an alias; it does not rewrite raw WhatsApp evidence or historical summary text.
- Next action: Commit and push, redeploy `api` and `propai-lab:main`, then correct the building through Super Admin and verify the public cards/details use the corrected canonical name.

## 2026-09-08 — Preserve and surface explicit unsupported property facts

- Requested outcome: Do not discard broker-provided details such as terrace when a provider misses the typed field; make schema-less facts visible in the internal app while keeping public www output safe.
- Changes: Added a source-grounded terrace fallback in `extraction.py` that preserves the exact terrace line in `terrace_area_raw_text` and `unstructured_facts` when the provider omits the typed value. Extended the extraction prompt with the `unstructured_facts` contract. Added an internal extraction-detail section titled `Additional property details` for unstructured facts and broker notes. Added a regression test for an explicit terrace mention.
- Verification: Focused P0 suite passed (`28 passed`); Python compilation passed; internal frontend production build passed with 74 routes; scoped `git diff --check` passed. Independent task-verifier verdict: PARTIAL because live worker/database replay and browser confirmation remain pending.
- Deployment/push: Not yet committed or pushed at report-writing time. Relevant services are `extraction-worker`, `api`, and `propai-lab:main-app`; no deployment performed.
- Limitations: Existing rows are not backfilled automatically. The new app section is on extraction detail; Market Inbox cards still show the source slice rather than a dedicated facts summary. Public www remains intentionally limited to public-safe typed facts.
- Next action: Commit and push, redeploy `extraction-worker`, `api`, and `propai-lab:main-app`, then reprocess one terrace listing and verify the fact appears under Additional property details without being exposed on www.

## 2026-09-08 — Remove broker marketing copy from public listing titles

- Requested outcome: Prevent titles such as `Direct Deal Very Good Flat` from appearing as public property identity.
- Changes: Public stored-title sanitization now rejects common broker marketing headers and falls back to verified typed facts, producing a grounded title such as `Semi-Furnished Residential property for Sale at Kurla`. Added a listing-card regression case.
- Verification: `apps/www` production build passed, including TypeScript and route generation; scoped `git diff --check` passed. The standalone `npx tsx test/listing-card.test.ts` runner was blocked by the restricted environment’s stream-file permission error. Independent task-verifier verdict: PARTIAL pending live browser confirmation after deployment.
- Deployment/push: Not yet committed or pushed at report-writing time. Relevant Coolify service is `propai-lab:main`; no deployment performed.
- Limitations: Existing persisted titles are unchanged in the database; the public renderer now ignores this class of bad title. Live production confirmation remains pending.
- Next action: Commit and push, redeploy `propai-lab:main`, then refresh the Manohar/Kurla listing and confirm the public title is structured rather than broker marketing copy.

## 2026-09-08 — Search extraction activity across the loaded dataset

- Requested outcome: Make broker-name search such as `Anil` return matching extraction records instead of searching only the current 30-row page.
- Changes: Added a backend `search` parameter to `/api/parsed`, searching building, locality, broker name/phone, group, transaction, and title fields before pagination. The extraction UI now sends the search term to the API and resets to page one when it changes.
- Verification: `routers/listings.py` and `storage/supabase.py` compiled; scoped `git diff --check` passed; internal frontend production build passed with 74 routes. Independent task-verifier verdict: PARTIAL pending live browser/database confirmation.
- Deployment/push: Not yet committed or pushed at report-writing time. Relevant services are `api` and `propai-lab:main-app`; no deployment performed.
- Limitations: The backend still uses the existing bounded typed-row fetch window per schema before applying the search, so a very large historical dataset may require a later database-native full-text/OR query optimization.
- Next action: Commit and push, redeploy `api` and `propai-lab:main-app`, then search for `Anil` and verify records outside the first page are returned.

## 2026-09-08 — Distinguish extraction quality from saved status

- Requested outcome: Stop internal extraction titles from exposing `not_specified` as if it were a real furnishing/property descriptor, and make low-confidence extraction status honest.
- Changes: Internal extraction titles now omit missing-value markers such as `not_specified` and fall back to `Property` when no configuration exists. Rows below 70% confidence or marked for review now show `Review needed` instead of `Saved`; the summary card now says `Saved rows` and `stored extraction records` rather than implying quality approval.
- Verification: Frontend production build passed with 74 routes; backend Python compilation and scoped `git diff --check` passed. Independent task-verifier verdict: PARTIAL pending live browser confirmation and investigation of the unavailable extraction-progress endpoint.
- Deployment/push: Not yet committed or pushed at report-writing time. Relevant service is `propai-lab:main-app`; no deployment performed.
- Limitations: This corrects the dashboard’s interpretation and presentation; it does not re-extract existing low-confidence rows. The progress warning is a separate API/database health issue and remains unresolved.
- Next action: Commit and push, redeploy `propai-lab:main-app`, then verify the screenshot rows show grounded titles and `Review needed` at 40% confidence.

## 2026-09-08 — Add manual refresh for homepage market snapshot

- Requested outcome: Make the homepage Market Snapshot refresh when newly published inventory or live metrics are available.
- Changes: Added a `Refresh data` control that calls `router.refresh()` for a fresh server render, and synchronized animated counters with refreshed SSR values. Metrics continue to come from the live `get_public_market_metrics()` RPC.
- Verification: `apps/www` production build and TypeScript check passed; scoped `git diff --check` passed; Impeccable detector returned no findings. Independent task-verifier verdict: PARTIAL because live browser confirmation after redeployment remains pending.
- Deployment/push: Commit `a08e0e57` was pushed to `origin/main`. Relevant Coolify service: `propai-lab:main`; no deployment performed.
- Limitations: Counts change only after new inventory has reached the public listings projection; the refresh control cannot make an unprocessed WhatsApp message appear immediately.
- Next action: Redeploy `propai-lab:main`, click `Refresh data`, and verify the numbers change after a newly published public listing.

## 2026-09-08 — Remove NVIDIA from extraction worker

- Requested outcome: Stop the extraction worker from selecting NVIDIA providers and remove NVIDIA from its Coolify/configuration path.
- Changes: Deleted `NVIDIA_API_KEY`, `NVIDIA_API_KEY_2`, `NVIDIA_API_KEY_3`, `NVIDIA_API_KEY_4`, and `NVIDIA_MODEL` from the extraction-worker production and preview scopes in Coolify. Removed the same five variables from `deploy/coolify/docker-compose.yml` for the extraction-worker service only.
- Verification: Coolify environment listing contains no `NVIDIA_*` variables for `extraction-worker` (`fpmr99xoi9qc7bdclals8jzb`). Deployment `hnh9qohpx9i00a2olzbo6n2k` finished successfully on commit `5df884282099101cc9769f056f10c419d125483c`. Post-deploy logs show the worker restarted without NVIDIA provider entries. Scoped `git diff --check` passed. Independent task-verifier verdict: PASS.
- Deployment/push: Commit `5df88428` pushed to `origin/main`; Coolify `extraction-worker` redeployed successfully. No other services were redeployed.
- Limitations: NVIDIA remains configured for unrelated API/enrichment services. The worker still has stale-window/consent skips and duplicate claim `409` log noise; those are separate follow-up issues.
- Next action: Configure or validate the remaining extraction provider, then run a small authorized canary/replay batch before draining the backlog.
## 2026-09-08 — Add Super Admin PropAI Journal

- Requested outcome: Add a blog management surface in `app.propai.live` so Super Admin can create, edit, draft, publish, and delete property/locality articles for Google-indexable pages on `www.propai.live`.
- Changes: Added the versioned `public.blog_posts` migration with draft/published RLS; added the Super Admin Journal editor at `/admin/blog`; added public `/blog` and `/blog/[slug]` server-rendered pages with safe plain-text headings/bullets, metadata, canonical URLs, navigation links, and sitemap entries.
- Verification: `apps/www` production build passed with 48 routes; `frontend` production build passed with 75 routes; scoped `git diff --check` passed; Impeccable detector returned no findings. Independent task-verifier verdict: PARTIAL because the production migration could not be applied with the available Supabase token and live browser verification is pending.
- Deployment/push: Commit `5fbc8387` pushed to `origin/main`. Relevant services are `propai-lab:main-app` for the Super Admin UI, `propai-lab:main` for public journal pages, and Supabase for the schema migration. No deployment performed.
- Limitations: The migration request reached Supabase but returned HTTP 401 Unauthorized, so the live `blog_posts` table/policies do not yet exist. Articles will remain unavailable until the migration is applied and both Coolify services are redeployed. No article content was seeded; publish only reviewed, source-backed copy.
- Next action: Provide a valid Supabase management token or apply `supabase/migrations/20260908120000_public_blog_posts.sql`, redeploy `propai-lab:main-app` and `propai-lab:main`, then create and publish the first article from Super Admin.

## 2026-09-08 — Clarify extraction processing counters

- Requested outcome: Make the extraction dashboard accurately describe what its coverage percentage and queue counts represent.
- Changes: Renamed the coverage section to `Message processing status`; changed the percentage and counter labels to say messages are `marked processed`; renamed the recent counter to `Marked processed recently`; added clear helper text that these are raw-message ledger counts, not quality or publishing scores, and that processed records can still require review.
- Verification: Frontend production build passed with 75 routes; scoped `git diff --check` passed. Independent task-verifier verdict: PASS for the requested copy/label correction. Impeccable detector reported three pre-existing gray-on-color warnings elsewhere in the extraction detail surface; none were introduced by the changed copy.
- Deployment/push: Not yet committed or pushed at report-writing time. Relevant Coolify service: `propai-lab:main-app`; no deployment performed.
- Limitations: The underlying live RPC counters remain raw ledger metrics by design; this change makes that boundary explicit and does not add a typed-extraction success metric.
- Next action: Commit and push, redeploy `propai-lab:main-app`, then refresh `/extractions` and confirm the new wording is visible.

### Follow-up status

- The wording change is included in pushed commit `5fbc8387` on `origin/main`.
- Coolify deployment attempt `ay0va58z0cq1qknb9iisbgzp` failed before build because the app's HTTPS GitHub checkout requested credentials. The currently running `propai-lab:main-app` has not been replaced by this change.
- Next action: repair the Coolify GitHub source authentication, redeploy `propai-lab:main-app`, and verify `/extractions` live.

## 2026-09-08 — Fix extraction warning contrast

- Requested outcome: Make the extraction progress warning readable in the internal dashboard light theme.
- Changes: Replaced the low-contrast amber Tailwind text/background combination with a semantic `extraction-progress-warning` class using the dashboard warning background, dark primary text, and warning-colored border.
- Verification: Frontend production build passed with 75 routes; scoped `git diff --check` passed; Impeccable detector reported only three pre-existing contrast warnings elsewhere on the page. Independent task-verifier verdict: PASS for the requested warning-contrast change.
- Deployment/push: Commit `f5dcc365` pushed to `origin/main`; Coolify deployment `g5ch1br4ou3jb6ikjqmtsb8p` for `propai-lab:main-app` finished successfully on that commit. Coolify reports the application running and online at `app.propai.live`.
- Limitations: This fixes the warning’s visibility; it does not resolve the separate degraded extraction-progress data source that causes the warning to appear.
- Next action: Investigate the underlying extraction-progress endpoint/database health separately if the warning continues after its data source is restored.

## 2026-09-08 — Fix Super Admin Journal database loading

- Requested outcome: Make `/admin/blog` load and manage `blog_posts` after the production migration was applied.
- Changes: The API admin table guard now allows the dedicated `blog_posts` editorial table without depending on the expensive observability snapshot RPC, which was timing out and causing the page's 503 response. Other admin tables remain catalog-validated.
- Verification: Python compilation, scoped `git diff --check`, and a focused `_admin_control_table("blog_posts")` assertion passed. Production Supabase verification confirmed the table, RLS, public-read policy, and timestamp trigger. Independent task-verifier verdict: PARTIAL because the API fix is pushed but has not yet been redeployed and live page verification is pending.
- Deployment/push: Commit `16a21125` pushed to `origin/main`; no Coolify deployment performed. Relevant service: `api`.
- Limitations: The existing observability snapshot timeout remains a separate dashboard health issue; this change isolates Journal CRUD from it.
- Next action: Redeploy `api`, reload `https://app.propai.live/admin/blog`, and verify the page shows `No articles yet` or the saved article list instead of 503.

## 2026-09-08 — Deploy blog admin fix and standardize Blog terminology

- Requested outcome: Replace the confusing “Journal” wording with “Blog” and make the Super Admin blog page usable after the database-loading 503.
- Changes: Renamed the admin heading, public-blog link, excerpt helper, and empty state to use “Blog”; updated public navigation, article metadata, and back links to use the same term. The previously committed API allowlist fix keeps `blog_posts` CRUD independent of the timing-out observability snapshot RPC.
- Verification: `frontend` production build passed with Supabase build variables; `apps/www` production build passed; scoped `git diff --check` passed; Impeccable detector returned no findings. Independent task-verifier verdict: PARTIAL because the deployment state is verified but authenticated live-page confirmation was not possible from this environment; API logs still show the separate extraction-progress RPC timeout, while contact-broker requests return 200.
- Deployment/push: Commit `8d12f80d` pushed to `origin/main`. Coolify deployments finished successfully for `api` (`penasvywkx5myjucg9eda4rg`), `propai-lab:main-app` (`ug00wcyiui5n0kaj5ggxtom8`), and `propai-lab:main` (`yq7duh9o83245fvlyrd22yn7`).
- Limitations: The extraction-progress timeout remains a separate API health issue. Please hard-refresh `/admin/blog`; it should now say “PropAI Blog” and should no longer depend on that timeout for its article list.
- Next action: If the alert remains after a hard refresh, capture the browser Network response for `/admin/supabase-table/blog_posts?limit=100&offset=0` so the remaining authenticated failure can be isolated.

## 2026-09-09 — Restore live extraction progress counts

- Requested outcome: Make the Extraction Activity pipeline coverage and queue counters show current database values instead of a degraded snapshot.
- Changes: Replaced the raw-message tenant index with a covering index for `processed`, `processed_at`, and `extraction_suppressed`, and added the reproducible migration `supabase/migrations/20260908230000_cover_extraction_progress_counts.sql`. Updated the progress test double and async fallback test to match the workspace-scoped RPC.
- Verification: The live `get_workspace_extraction_progress` RPC returned HTTP 200 in 1.08 seconds with real values: 112,249 total raw messages, 86,934 processed, 10,185 eligible pending, 15,130 consent-suppressed, and 77.45% processed. Five focused progress tests passed; Python compilation and scoped `git diff --check` passed. Independent task-verifier verdict: PASS for the requested data-path fix.
- Deployment/push: The covering index and `ANALYZE` were applied directly to the production Supabase database; commits `9d438b51` and `1d409d22` were pushed to `origin/main`. No application redeploy is required because the API/UI code was unchanged for this database fix; refresh `app.propai.live/extractions` to call the recovered RPC.
- Limitations: An older redundant covering index may remain in the database and can be cleaned up during a later maintenance window. The dashboard still intentionally returns an explicit degraded warning if the database becomes unavailable again; it no longer fabricates zero counts.
- Next action: Hard-refresh `/extractions` and confirm the coverage bar and counters populate. Monitor API logs for further `57014 statement timeout` entries.

## 2026-09-09 — Fix blog 503 and improve public blog layout

- Requested outcome: Remove the persistent Super Admin blog 503 and make the public blog feel like a real editorial destination rather than a basic list.
- Changes: Replaced unsupported `.range()` pagination in the custom Supabase REST adapter with its supported `.limit().offset()` API; added an actionable Retry control to the admin error state; added a featured article treatment, live published-guide count, and a “More from PropAI” reading section to the public blog.
- Verification: Production builds passed for `frontend` and `apps/www`; Python compilation and scoped `git diff --check` passed; Impeccable detector returned no findings. Independent task-verifier verdict: PARTIAL pending an authenticated browser refresh after deployment; production logs now show the API restarted cleanly and no new `blog_posts` 503 after deployment.
- Deployment/push: Commit `531417bf` pushed to `origin/main`. Coolify deployments finished successfully for API (`fh2h7hhvxykx48f2kqku43bh`), `propai-lab:main-app` (`p7a0j80dfdjvajn61rghku1e`), and public site (`wu82hpii8mimf6k4u12qa958`; Coolify reports deployed commit `9d438b5`).
- Limitations: The public blog remains empty until the first article is saved and published. The separate extraction-progress RPC timeout is unrelated and remains a known API health issue.
- Next action: Hard-refresh `/admin/blog`, confirm the 503 is gone, then publish the first source-backed article to validate the full editor-to-public-blog path.

## 2026-09-09 — Polish Super Admin blog workspace

- Requested outcome: Make the Super Admin blog screen feel like a proper publishing workspace rather than a basic form.
- Changes: Added a live article preview with cover treatment, category, title, excerpt, slug, and reading-time estimate; added a publishing checklist with live completion progress; improved the article library empty state while preserving existing draft, publish, edit, and delete behavior.
- Verification: Frontend production build passed with 75 routes; scoped `git diff --check` passed; Impeccable detector returned no findings. Independent task-verifier verdict: PASS for the requested UI change and deployment.
- Deployment/push: Commit `0a2720e8` pushed to `origin/main`; Coolify deployment `okp19jp2mm60eg0kk5dfdv5o` for `propai-lab:main-app` finished successfully.
- Limitations: The library remains empty until an article is saved. Cover images still use an optional URL; no image upload workflow was added.
- Next action: Refresh `/admin/blog` and start writing; the preview and checklist update as the fields are completed.

## 2026-09-09 — Add rich formatting to blog editor

- Requested outcome: Give the Super Admin blog editor real rich authoring controls instead of a plain textarea.
- Changes: Added toolbar actions for H2 headings, bold, italic, bullet lists, quotes, links, and dividers. Formatting is stored as a deliberately small safe text format and now renders on public article pages without injecting HTML.
- Verification: Frontend and public-site production builds passed; scoped `git diff --check` passed; Impeccable detector returned no findings. Independent task-verifier verdict: PASS for the requested editor capability and deployments.
- Deployment/push: Commit `aa8ec188` pushed to `origin/main`; Coolify deployments finished successfully for `propai-lab:main-app` (`j67dzscvomwdg1blvz3ypv0z`) and `propai-lab:main` (`v262dz2f8ae1p5uscofhw63p`).
- Limitations: This is a safe Markdown-style rich editor rather than arbitrary HTML/Word-style formatting; it intentionally avoids unsafe HTML injection.
- Next action: Refresh `/admin/blog` and use the formatting toolbar while writing the first source-backed article.

## 2026-09-09 — Repair market repost projection and broker hiding

- Requested outcome: Stop reposted WhatsApp inventory from rendering as duplicate cards and provide a reversible way to hide a broker from Market Inbox.
- Outcome: Partial pending production redeployment. The shared and broker-scoped projections now deduplicate reposts using structured opportunity identity instead of raw-message hashes, apply workspace broker hiding to both paths, and the admin evidence endpoint now exposes linked duplicates plus classification gaps instead of hiding newer mismatches.
- Changes: Updated `storage/supabase.py`, `routers/admin.py`, `frontend/src/app/inbox/page.tsx`, `frontend/src/app/admin/dedupe-gate/page.tsx`, `tests/test_admin_dedupe_gate.py`, `tests/test_canonical_opportunity_identity.py`, and `architecture.md`.
- Verification: Focused tests passed: 28 passed across canonical identity, dedupe gate, data-quality guard, and market-card suites. Frontend production build passed. `git diff --check` and Python compilation passed. Independent task-verifier verdict: PARTIAL — local code paths are verified, but the updated API/internal-app deployment and live duplicate-card retest are still pending.
- Deployment/push: Commit `47e60126` pushed to `origin/main`. Coolify services requiring redeployment: `api` and `propai-lab:main-app`; no redeployment was performed.
- Limitations/failures: Existing broad regression collection still has unrelated failures from missing optional `langgraph`, stale fixtures, and pre-existing typed-schema assumptions. No production rows were deleted or rewritten.
- Next action: Commit and push only the affected hunks, redeploy `api` and `propai-lab:main-app`, then retest a known duplicate broadcast and the Hide broker/undo flow in the live app.

## 2026-09-09 — Keep Market Inbox evidence scoped to the selected listing

- Requested outcome: Show only the relevant WhatsApp listing block under “Applicable WhatsApp excerpt”; keep the complete multi-list broadcast available only through “View full broadcast evidence”.
- Changes: Fixed the source-boundary conflict in `storage/supabase.py`: a full raw broadcast can no longer win merely because it is longer than the matching block. Added separator-aware block detection for common broker broadcast delimiters. Updated the inbox renderer in `frontend/src/app/inbox/page.tsx` so it never falls back to the full broadcast inside the applicable-excerpt section; an unisolated block is stated explicitly and the full source remains separately expandable. Added a regression covering a multi-list broadcast with the same separator pattern shown in the report.
- Verification: 34 focused source-boundary/evidence tests passed; `frontend` production build passed with 75 routes; scoped `git diff --check` passed. Independent task-verifier verdict: PARTIAL — local implementation and tests pass, but production redeployment and a live authenticated Market Inbox retest remain pending.
- Deployment/push: Code is ready to commit and push. Relevant services requiring redeployment are `api` and `propai-lab:main-app`; no redeployment was performed in this turn because it was not explicitly requested.
- Limitations: If a broadcast has no recognizable heading/separator and no reliable building anchor, the system will report that a listing-specific excerpt could not be isolated rather than inventing a boundary. Existing full raw evidence is not deleted.
- Next action: Commit/push the scoped changes, redeploy `api` and `propai-lab:main-app`, then expand the same Market Inbox card and confirm the excerpt contains only the selected listing block.

## 2026-09-09 — Parse apostrophe decimal price shorthand

- Requested outcome: Interpret broker price text such as `4'25 Cr` as ₹4.25 Cr instead of ₹425 Cr or another inflated value.
- Changes: Updated the shared explicit-price parser, source-attached fallback, AI-to-typed extraction bridge, and plausibility grounding parser to treat straight or curly apostrophes between price digits as decimal separators. Added extraction prompt guidance and a typed-pipeline regression test.
- Verification: The focused regression passed (`1 passed`); direct canonical, source-attached, plausibility-grounding, typed extraction, Python compilation, and scoped `git diff --check` checks passed. Independent task-verifier verdict: PASS. A broader focused module run had one unrelated pre-existing broker-RERA assertion failure; the full extraction module is also blocked locally by missing optional `langgraph`.
- Deployment/push: Changes are ready for commit and push. Relevant service requiring redeployment: `api`; no redeployment performed in this turn.
- Limitations: This corrects future extraction and source-grounded conversion; existing incorrectly persisted prices require a separate reviewed data repair and were not modified.
- Next action: Commit/push the scoped changes, redeploy `api`, then reprocess or review the affected listing so the card displays ₹4.25 Cr.

## 2026-09-09 — Clarify building enrichment review ownership

- Requested outcome: Replace the vague “Needs attention” enrichment state with a clear explanation of what happened, who must act, and what to do when Google Places cannot safely confirm a building such as Jolly Maker.
- Changes: Updated `frontend/src/app/admin/building-enrichment/page.tsx` to label failed jobs “Review required,” explain competing-locality and no-confident-match cases in plain language, show “Who acts: enrichment operator,” and add a per-job “Next action” column.
- Verification: Frontend production build passed with 75 routes; scoped `git diff --check` passed; Impeccable detector returned no findings. Independent task-verifier verdict: PASS for the requested UI clarification.
- Deployment/push: Ready to commit and push. Relevant service requiring redeployment: `propai-lab:main-app`; no redeployment performed in this turn.
- Limitations: This clarifies the existing review state and does not add a retry API or automatically resolve Jolly Maker’s competing locality evidence.
- Next action: Commit/push, redeploy `propai-lab:main-app`, then refresh Pipeline Health → Building Enrichment and confirm the Jolly Maker card shows the review reason and next action.

## 2026-09-09 — Gate building enrichment behind identity review

- Requested outcome: Stop sending every discovered building candidate to Google Places; let an operator edit/confirm the name and locality first, or reject candidates that are not building names.
- Changes: Automatic discovery and context-triggered requeues now use `needs_review`; only explicit super-admin approval moves a job to `pending`. Added the admin review API, edit/reject storage flow, review queue counts, and a Building Enrichment “Review & enrich” modal. Added migration, architecture invariant, and focused regression tests.
- Verification: Python compilation passed; 30 focused enrichment tests passed; frontend production build passed with 75 routes; scoped `git diff --check` passed. Impeccable detector reported only existing one-line table contrast warnings. Independent task-verifier verdict: PASS for the local implementation acceptance conditions.
- Deployment/push: Commits `b97ef5ab` and `6f1c00f5` pushed to `origin/main`. Not deployed in this turn. Relevant services requiring redeployment: `api`, `extraction-worker`, and `propai-lab:main-app`.
- Limitations: The migration has not been applied to production and live review/enrichment behavior has not yet been browser-tested. Existing jobs already running are not cancelled; never-attempted pending candidates are converted by the migration.
- Next action: Apply the migration through the normal Supabase deployment path, redeploy the three services, then approve one known candidate and reject one non-building candidate in the live admin page.
## 2026-09-09 — Expand explicit JODI and dual-transaction opportunities

- Requested outcome: When a broker explicitly says a JODI is available as separate units, create one combined JODI listing plus two individual-unit listings; show the relationship on cards; and create separate sale and rent cards when both are explicitly offered.
- Changes: Added source-scoped expansion in `extraction.py`; added `configuration_details`, `is_combination_unit`, and `can_sell_separately` through parsed observations and Market Inbox projections; added JODI/individual-unit chips to both Market Inbox and the shared listing card; added the invariant to `architecture.md` and source-quality documentation. Individual units never inherit a combined price; they remain reviewable until their own price is explicitly present.
- Verification: 42 focused backend tests passed, including three-record JODI expansion, separate sale/rent expansion, and no inherited individual price. Python compilation and `git diff --check` passed. Frontend production build passed with 75 routes. Impeccable detector reported only pre-existing contrast warnings in `ListingCard.tsx`. Independent task-verifier verdict: PASS.
- Deployment/push: Commit `ebaa9054` pushed to `origin/main`. Coolify deployments finished successfully for `extraction-worker` (`th56g7rtmuazzggjsktjqsjy`) and `propai-lab:main-app` (`bn700f9bz2if76348t7vmocp`). Public `propai-lab:main` was not changed or redeployed.
- Limitations: The expansion is intentionally gated to explicit wording inside the item-scoped source slice; same-building similarity cannot create JODI or dual-transaction variants. Individual prices are not inferred from the combined quote.
- Next action: Send or replay a source message explicitly containing a JODI plus “available for sale individually” (and, separately, an explicit sale-and-rent opportunity) and confirm the resulting cards in Market Inbox.

## 2026-09-09 — Make enrichment review actions visible

- Requested outcome: Stop the Building Enrichment review action from being pushed off-screen and improve the contrast of review-related table text.
- Changes: Changed the enrichment activity area to a full-width layout, removed the forced 1020px table width, added fixed responsive column proportions and word wrapping, and replaced pale-on-light amber action text with darker, focused action styling.
- Verification: Frontend production build passed with 75 routes; scoped `git diff --check` passed. Impeccable detector reported existing contrast warnings in the unchanged amber/rose summary callouts. Independent task-verifier verdict: PASS for the local UI acceptance conditions.
- Deployment/push: Ready to commit and push. Relevant service requiring redeployment: `propai-lab:main-app`; no deployment performed in this turn.
- Limitations: Live browser verification after this latest UI adjustment remains pending.
- Next action: Redeploy `propai-lab:main-app`, then refresh `/admin/pipeline-health?tab=enrichment` and confirm the Review column remains visible without horizontal scrolling.

## 2026-09-09 — Paginate and filter enrichment review queue

- Requested outcome: Make the Building Enrichment review list searchable, filterable, and paginated instead of limiting operators to the latest rows.
- Changes: Added a service-role RPC and admin API endpoint for server-side page, status, provider, and building/locality search filters. Updated the dashboard with search controls, status/provider selectors, result counts, and Previous/Next pagination.
- Verification: Frontend production build, Python compilation, and scoped `git diff --check` passed. Independent task-verifier verdict: PARTIAL pending production migration application and live browser verification.
- Deployment/push: Ready to commit and push. Relevant services: `api` and `propai-lab:main-app`; the new migration must be applied before the endpoint works in production. No deployment performed in this turn.
- Limitations: The existing summary RPC remains unchanged; the new browser RPC is required for the paginated table.
- Next action: Apply `20260909152000_building_enrichment_job_browser.sql`, redeploy `api` and `propai-lab:main-app`, then verify search and pagination on `/admin/pipeline-health?tab=enrichment`.
## 2026-09-09 — Paginate and search the Buildings directory

- Requested outcome: Do not load every building at once, but do not misleadingly stop at the first 100 records; show the live total and let the broker browse the complete directory.
- Changes: The Buildings page now requests 25 records per page, displays the live range and total, and provides Previous/Next controls. Search is sent to the API and applies across the directory, including building name, locality, developer, and building ID. The API returns the filtered total alongside each page.
- Verification: Python compilation and `git diff --check` passed. Frontend production build passed with 75 routes. Independent task-verifier verdict: PASS.
- Deployment/push: Commit `f62b8f19` pushed to `origin/main`. API deployment `pchgps0ovxxvd5cwj4b8ujph` finished successfully. The first internal-app deployment hit a transient Docker builder failure while copying `node_modules`; retry `a49cn2g0xok2bgspck6qs0f7` finished successfully.
- Limitations: Summary panels rank and aggregate the currently loaded 25-building page; the directory itself is fully paged and searchable. A later refinement could provide server-side summary aggregates across all buildings if needed.
- Next action: Refresh `app.propai.live/buildings`; use Next or search a building beyond the first page.
## 2026-09-09 — Isolate bullet-separated commercial evidence slices

- Requested outcome: Stop Market Inbox cards from showing unrelated listings inside “Applicable WhatsApp excerpt”; retain the complete broadcast only as full evidence.
- Changes: Extended the source-boundary detector to recognize bullet/dot separators used by the commercial broadcast format, allowing the matching office block to be selected even when the broker’s building spelling differs slightly.
- Verification: 37 focused market-evidence/card tests passed; Python compilation and `git diff --check` passed. Independent task-verifier verdict: PASS.
- Deployment/push: Commit `4ce3f520` pushed to `origin/main`. API deployment `m33wn43yyund05c9h6y68fs4` finished successfully; the deploy client timed out while waiting on an earlier request but Coolify reported the deployment finished. Internal app deployment `dmu5wxchr3msj12i5vsj7esy` finished successfully.
- Limitations: If a broadcast has no recognizable separator or reliable building anchor, the UI continues to disclose that a listing-specific excerpt could not be isolated rather than showing unrelated text.
- Next action: Hard-refresh Market Inbox, expand the Singapore/Singage Borde card, and confirm only its office block appears under the applicable excerpt.

## 2026-09-09 — Repair duplicate Market Inbox opportunities

- Requested outcome: Stop the same commercial listing from appearing as multiple Market Inbox cards while preserving genuinely separate items in one WhatsApp broadcast.
- Changes: Canonicalized numeric extraction values in the market opportunity fingerprint so values such as `2300` and `2300.0` share one identity. Added a conservative secondary identity that merges re-indexed listings only across different source messages; same-message siblings remain separate. Documented the invariant in `architecture.md` and added regression tests.
- Verification: 77 focused market/dedupe/extraction tests passed; Python compilation and scoped `git diff --check` passed. Independent task-verifier verdict: PASS for local implementation. Production Supabase comparison was attempted read-only but the available query credential returned `Unauthorized`, so live row-level confirmation remains pending.
- Deployment/push: Code is ready to commit and push. Relevant service requiring redeployment: `api`; `propai-lab:main-app` should also be refreshed if the duplicate cards are coming from an already-cached feed response. No deployment performed in this turn.
- Limitations: Existing typed rows are not deleted or rewritten; deduplication is applied in the market-feed projection. Existing duplicate cards should collapse on the next API deployment and fresh feed request.
- Next action: Push the scoped commit, redeploy `api` (and refresh/redeploy `propai-lab:main-app` if needed), then hard-refresh Market Inbox and verify the Khar West/Singage Borde cards.

## 2026-09-09 — Split numbered rental broadcasts and replace generic titles

- Requested outcome: Extract each numbered property in the Bhagtani/Grotto/Amin Alturas/Georgina broadcast separately and prevent generic titles such as `Property with 93 sqft for rent at Grotto, Bandra West`.
- Changes: Added a conservative deterministic splitter for numbered, explicitly priced broadcast rows; dropped carpet area values that have no explicit area evidence; rejected the generic property-with-area title pattern; and added `Apartment`/`Office space` title fallbacks with locality wording such as `Apartment for rent in Grotto, Bandra West`.
- Verification: Three regression tests passed in `tests/test_numbered_broadcast_titles.py`; the existing P0 title/combination suite passed (`34 passed`); Python compilation and scoped `git diff --check` passed. Independent task-verifier verdict: PARTIAL pending worker replay and live dashboard/www verification.
- Deployment/push: Commit `d3d6bacc` pushed to `origin/main`. Relevant services requiring redeployment are `extraction-worker`, `api`, `propai-lab:main-app`, and `propai-lab:main`; no deployment performed.
- Limitations: Existing malformed typed rows are not rewritten by this code change. New extraction or an explicit reprocess is required for the affected broadcast.
- Next action: Redeploy the extraction/API/internal/public services, then reprocess the source message and confirm four cards plus the corrected public title.

## 2026-09-09 — Complete the Super Admin extraction trace

- Requested outcome: Make `/extractions` a useful Super Admin control surface instead of a results-only list.
- Changes: The page now uses stored `summary_title` values, filters by quality state, shows source slices beside the full WhatsApp message, exposes provider/model and schema provenance, validation flags, raw AI output, and extraction decisions, and supports bounded field corrections plus single-message retry through the existing authenticated API paths. Updated the product and architecture contracts to document this audit boundary.
- Verification: Frontend production build passed for all 75 routes with the standard placeholder Supabase build environment; scoped ESLint completed with existing hook/`any` warnings and no errors; scoped `git diff --check` passed; Impeccable detector reported contrast warnings caused by the page’s existing long JSX lines and colored surfaces. Independent task-verifier verdict: PARTIAL pending live deployment and authenticated browser verification of correction/retry actions.
- Deployment/push: Commit `d1a15fd3` pushed to `origin/main`. Relevant service requiring redeployment: `propai-lab:main-app`; the existing `api` retry/correction endpoints are already present and unchanged.
- Limitations: This adds single-row correction/retry controls, not bulk correction or a separate human approval state. Retry remains asynchronous and requires the extraction worker to process the queued source message.
- Next action: Redeploy `propai-lab:main-app`, then open `/extractions` as Super Admin and verify source trace, correction save, and retry queue feedback on a known record.

## 2026-09-09 — Correct commercial rent quote interpretation

- Requested outcome: Stop explicit commercial rent totals such as `5.50Lacs + GST` from being treated as PSF rates and multiplied by area, while preserving genuine PSF pricing.
- Changes: The extraction price boundary now trusts an explicit unit-bearing broker quote unless the quote itself says PSF/per sqft. The API’s legacy card projection also corrects clearly identifiable historical commercial rows using the stored source quote; genuine PSF rows remain unchanged. Added source-slice and projection regressions.
- Verification: 13 focused tests passed; Python compilation and staged `git diff --check` passed. Independent task-verifier verdict: PARTIAL — local code and tests pass, extraction-worker deployment finished, but the API deployment for this commit failed once during dependency-image build and a later Coolify API build for another commit remained in progress; live card verification is pending.
- Deployment/push: Commit `8d361e0e` pushed to `origin/main`. Extraction-worker deployment finished on this commit. API deployment needs retry/confirmation for `8d361e0e`; no production data was directly rewritten because the available Supabase query credential returned `Unauthorized`.
- Limitations: Existing cards use the projection repair only after the API is running the new image; persisted typed rows still need a reviewed source-grounded backfill if permanent database correction is required.
- Next action: Let the current API build finish or retry API deployment on `8d361e0e`, then hard-refresh Market Inbox and confirm `₹5.50 Lakh/month` rather than `₹126.50 Cr/month` for the affected office card.

## 2026-09-09 — Expose commercial carpet-terrain and parking details in extraction trace

- Requested outcome: Make the Super Admin extraction detail show the source-backed `3,517 Sq. Ft. Carpet Area`, `1,200 Sq. Ft. Carpet Terrace`, and `8 Podium Car Parks` instead of leaving those details only in the full WhatsApp evidence.
- Changes: Extended the extraction detail row typing and detail view to render explicit carpet-area, carpet-terrace, and parking facts. The UI keeps terrace separate from the main area and does not add the figures together; it also falls back to the stored source area text when a dedicated carpet raw-text field is absent.
- Verification: Frontend production build passed for all 75 routes; scoped ESLint completed with no errors and only the existing hook/`any` warnings; scoped `git diff --check` passed; Impeccable detector reported the existing contrast warnings on the long extraction-detail JSX. Independent task-verifier verdict: PARTIAL pending live deployment and authenticated browser verification.
- Deployment/push: Commit `32165762` pushed to `origin/main`. Relevant service requiring redeployment: `propai-lab:main-app`; no deployment performed.
- Limitations: The detail shows fields present in the typed row and source payload. It does not merge separate Option 1/Option 2 blocks into one listing, preserving source boundaries.
- Next action: Redeploy `propai-lab:main-app`, hard-refresh `/extractions`, and open the Lodha Supremus row to confirm the three explicit detail labels.

## 2026-09-09 — Improve selected extraction source readability

- Requested outcome: Make the selected source text clearly readable and directly comparable with the extracted card values.
- Changes: Restyled the selected source slice with high-contrast dashboard theme tokens, preserved whitespace and line breaks, and labeled it as the exact broker text. This keeps source values such as `Carpet 1600 sqft / 2280 sqft` visible without altering extraction data.
- Verification: Frontend production build passed for all 75 routes; extraction-page ESLint passed with no errors and only the two existing React effect warnings; scoped `git diff --check` passed. Independent task-verifier verdict: PARTIAL pending live deployment and authenticated browser verification.
- Deployment/push: Commit `d5d179f3` pushed to `origin/main`. Relevant service requiring redeployment: `propai-lab:main-app`; no deployment performed.
- Limitations: The UI presents the stored source slice and structured fields; it does not reinterpret multiple options into a single combined area.
- Next action: Redeploy `propai-lab:main-app` and hard-refresh `/extractions` to verify the selected source panel in the browser.

## 2026-09-09 — Prevent adjacent offers in extraction source slices

- Requested outcome: Ensure the selected source text for one extraction does not display a second offer from the same historical broadcast slice.
- Changes: Added a backend extraction-source resolver that reuses source-boundary logic and uses a unique row price/title anchor when the stored building value is noisy. The `/api/parsed` response now exposes the resolved `source_slice_text`, while the full WhatsApp message remains separately available. Added a regression test for the two-offer 2 BHK/commercial example.
- Verification: 40 focused source/title/market tests passed; Python compilation and scoped `git diff --check` passed; frontend production build passed for all 75 routes. Independent task-verifier verdict: PARTIAL pending live deployment and authenticated browser verification.
- Deployment/push: Commit `ea961f0c` pushed to `origin/main`. Relevant services requiring redeployment: `api` and `propai-lab:main-app`; no deployment performed.
- Limitations: If no unique source anchor exists, the resolver deliberately preserves the complete slice rather than inventing a boundary.
- Next action: Redeploy `api` and `propai-lab:main-app`, then open the same extraction and confirm only the 2 BHK offer appears in Selected source slice.

## 2026-09-09 — Make extraction detail schema-aware

- Requested outcome: Stop showing only generic extraction metrics and expose relevant fields such as BHK for residential rows.
- Changes: Added a schema-aware “Relevant extracted fields” section and matching correction controls. Residential listings now expose BHK, carpet area, price/rent, furnishing, parking, and floor; commercial rows expose commercial use, carpet area, price/rent, fit-out, parking, and floor; requirements expose BHK options, area and budget ranges, furnishing, and parking minimums. Corrections use the existing bounded `/api/parsed/{id}` endpoint.
- Verification: Frontend production build passed for all 75 routes; extraction-page ESLint passed with no errors and only the existing effect warnings; scoped `git diff --check` passed; Impeccable detector reported existing contrast warnings on the page’s older metric/progress surfaces. Independent task-verifier verdict: PARTIAL pending live deployment and authenticated browser verification.
- Deployment/push: Commit `e434db24` pushed to `origin/main`. Relevant service requiring redeployment: `propai-lab:main-app`; no deployment performed.
- Limitations: The view is schema-aware at the extraction-detail layer; it does not alter the underlying AI extraction or source evidence.
- Next action: Redeploy `propai-lab:main-app`, open a residential row, and verify BHK is visible and editable.

## 2026-09-09 — Recover omitted BHK from unanimous broadcast context

- Requested outcome: For the Royal Classic residential-rent broadcast, show the correct BHK instead of `Not extracted` when the source list consistently identifies every offer as 3 BHK.
- Changes: Added a deterministic source-grounded fallback in `extraction.py`. It fills a missing provider BHK only when the item slice has one explicit value or every explicit BHK marker in the complete broadcast has the same value. It records `source_bhk_context_fallback` in the extraction trace and leaves mixed-BHK broadcasts unresolved. Added positive and mixed-BHK regression tests and documented the invariant in `architecture.md`.
- Verification: The two new focused tests passed. `git diff --check` passed. The broader typed extraction file still has unrelated pre-existing failures in route classification, PSF assertions, and broker-field regressions; those were not changed by this task. Independent task-verifier verdict: PARTIAL because production worker/API deployment and authenticated browser verification remain pending.
- Deployment/push: Code is ready to commit and push. Relevant services requiring redeployment: `extraction-worker` for new extraction persistence and `api` plus `propai-lab:main-app` for the audit display. No deployment performed in this turn.
- Limitations: Existing rows are not rewritten automatically; the affected source must be reprocessed or corrected after redeployment. A broadcast containing both 2 BHK and 3 BHK intentionally remains unresolved when the selected slice lacks its own BHK marker.
- Next action: Redeploy `extraction-worker`, `api`, and `propai-lab:main-app`, then retry/reprocess the Royal Classic extraction and confirm the Relevant extracted fields card shows `BHK: 3`.

## 2026-09-09 — Centralize pre-AI extraction classification ownership

- Requested outcome: Decide how to consolidate the fragmented structural classification across `deterministic_splitters.py`, `ai_extraction.py`, and `extraction.py` before building the larger message-block classifier.
- Changes: Added `preflight_classifier.py` as the single public ownership point for document type, splitter pattern, block count, and structural signals. Removed the duplicate heading/numbered-item heuristics from `ai_extraction.py`, kept `deterministic_splitters.py` as a low-level boundary primitive, and attached the preflight contract to both the extraction-worker context and AI provider context. The model is explicitly told to treat it as a hint and the raw message as authoritative. Added focused regression tests and documented the ownership boundary in `architecture.md`.
- Verification: `python3 -m py_compile preflight_classifier.py ai_extraction.py extraction.py` passed; `pytest -q tests/test_preflight_classifier.py` passed (`2 passed`); direct imports of `ai_extraction` and `extraction` passed; scoped `git diff --check` passed. The combined extraction-pipeline test collection remains blocked by the existing missing `langgraph` dependency (`ModuleNotFoundError`), unrelated to this change. Independent task-verifier verdict: PARTIAL because this is the ownership foundation, not yet the full block-type classifier or a production replay.
- Deployment/push: No deployment performed. Relevant services requiring redeployment after commit are `extraction-worker` and `api`; no frontend redeployment is required for this backend-only change. Commit and push remain pending in this turn.
- Limitations: The preflight result is currently metadata and provider guidance; it does not yet change segmentation or add new semantic extraction rules. Existing rows are not rewritten. The next classifier phase should be built against this contract and dry-run compared against the existing splitter/AI paths before activation.
- Next action: Commit and push this scoped refactor, then implement the larger block-type classifier behind a dry-run/evaluation path before changing production extraction behavior.

## 2026-09-09 — Show preflight classifier evidence in Super Admin

- Requested outcome: Make `preflight_classifier.py` observable in the Super Admin extraction trace rather than leaving its decisions invisible.
- Changes: Stored the preflight contract alongside each new AI extraction item; added a read-only source-slice recomputation for older rows; and exposed document type, boundary pattern, detected block count, structural signals, and evidence origin in `/extractions` under Structured result. The original source remains authoritative and no production rows are rewritten.
- Verification: Python compilation and backend imports passed; a representative numbered broadcast produced `Multi Listing`, `numbered`, `2` blocks, and `numbered_items`/`rent_cue`; the frontend production build passed with placeholder Supabase build variables for all 75 routes; the Impeccable detector reported only the page’s existing gray-on-colored-surface warnings. Independent task-verifier verdict: PARTIAL pending deployment and authenticated browser verification.
- Deployment/push: Commit `bdf6704c` pushed to `origin/main`. No deployment performed. Relevant services requiring redeployment are `extraction-worker`, `api`, and `propai-lab:main-app`.
- Limitations: Stored preflight evidence appears after new extraction-worker processing; older rows are explicitly labeled as recomputed from their source slice. This exposes the current classifier; it does not yet activate the larger block-type classifier or change extraction semantics.
- Next action: Commit and push the scoped backend/UI change, redeploy the three services, then open a known extraction in Super Admin and verify the preflight evidence against its source slice.

## 2026-09-09 — Restore source-grounded area values on market cards

- Requested outcome: Show area already present in the extracted/source record on Market Inbox cards, and stop `/extractions` from reporting stale building/location traceability warnings when the current row contains those fields.
- Changes: Market cards now prefer validated numeric area and fall back to stored `carpet_area_raw_text`/`area_raw_text`, including the compact broker-observation cards. Extraction decision notes now evaluate the current structured building, location, and broker identity fields instead of blindly repeating historical validation flags.
- Verification: Scoped `git diff --check` passed; frontend production build passed for all 75 routes with placeholder Supabase variables; the Impeccable detector reported only the pre-existing gray-on-colored warnings on the extraction page. Independent task-verifier verdict: PARTIAL because live authenticated card verification is still pending.
- Deployment/push: Commit `64bd5b40` pushed to `origin/main`. Relevant service requiring redeployment: `propai-lab:main-app`; no deployment performed.
- Limitations: If an older typed row has neither a numeric area nor stored raw area text, the card cannot recover an area from the full broadcast without risking showing another listing's area.
- Next action: Commit and push these scoped frontend changes, redeploy `propai-lab:main-app`, then hard-refresh Market Inbox and verify a row with source area text displays it on the card.

## 2026-09-09 — Make stale worker heartbeats visible in Super Admin

- Requested outcome: Begin the overall technical-debt backlog with TD-003, ensuring worker liveness is based on observed heartbeat freshness rather than a stale `running` status.
- Changes: The Super Admin database-health view now marks a running worker as stale after two minutes without a heartbeat, distinguishes live/degraded/stopped/stale states, counts stale workers as needing attention, and displays the latest worker error when present.
- Verification: Frontend production build passed for all 75 routes with placeholder Supabase variables; scoped `git diff --check` passed; the Impeccable detector returned no findings for the changed page. Independent task-verifier verdict: PARTIAL—the stale-heartbeat UI is verified locally, but live authenticated verification and the remaining queue-depth/throughput metrics are pending.
- Deployment/push: Commit `f080fc5b` pushed to `origin/main`. Relevant service requiring redeployment: `propai-lab:main-app`; no deployment performed.
- Limitations: This is the first TD-003 mitigation. It does not yet add durable last-successful-work timestamps, processed/failed counters, queue age, or effective configuration to every worker’s heartbeat.
- Next action: Commit and push this scoped UI change, redeploy `propai-lab:main-app`, verify a real stale heartbeat in Super Admin, then extend the heartbeat contract with queue and throughput evidence.

## 2026-09-09 — Add extraction worker activity evidence

- Requested outcome: Continue TD-003 after stale-heartbeat detection by exposing whether extraction workers are actually doing work, not only whether their process is alive.
- Changes: Extraction and extraction-reprocessing workers now publish last-cycle timestamps, last-work/last-success timestamps, cycle counts, and process totals/results inside the existing service-role heartbeat configuration payload. Super Admin renders the latest cycle’s attempted, succeeded, and failed activity alongside heartbeat freshness and errors.
- Verification: `python3 -m py_compile extraction_worker.py extraction_reprocessing_worker.py` passed; focused worker tests passed (`17 passed`); frontend production build passed for all 75 routes; scoped `git diff --check` passed; the Impeccable detector returned no findings for the changed admin page. Independent task-verifier verdict: PARTIAL because live worker heartbeat verification is pending redeployment.
- Deployment/push: Commit `c2f3dda4` pushed to `origin/main`. Relevant services requiring redeployment: `extraction-worker`, `extraction-reprocessing-worker` if separately deployed, and `propai-lab:main-app`; no deployment performed.
- Limitations: Queue depth and oldest queued item age are not yet measured. Building-enrichment and semantic workers still publish only basic heartbeat/config data.
- Next action: Redeploy the affected services, verify the new heartbeat payload in Super Admin, then add bounded queue-depth/oldest-item evidence and bring the remaining workers onto the same activity contract.

## 2026-09-09 — Show actionable extraction queue age

- Requested outcome: Continue TD-003 with a queue signal that reflects the real extraction contract rather than historical rows outside the 24-hour parsing window.
- Changes: Added a database-native observability migration that reports pending, unsuppressed group messages inside the 24-hour extraction window, the oldest actionable message, and its age. Super Admin now separates live extraction messages from the unrelated source-grounded review queue and labels the latter accordingly.
- Verification: Frontend production build passed for all 75 routes with placeholder Supabase variables; scoped `git diff --check` passed; the Impeccable detector returned no findings for the changed admin page. Independent task-verifier verdict: PARTIAL because the migration and live authenticated snapshot still require deployment verification.
- Deployment/push: Commit `f8509e76` pushed to `origin/main`. Relevant services are `api` for the database migration/RPC and `propai-lab:main-app` for the Super Admin UI. The separate review/reprocessing worker is not required for this live 24-hour queue signal; no deployment was performed by this session.
- Limitations: The migration is not applied by this local check, so the deployed RPC must be verified before the new metrics appear. Queue depth is an exact bounded-window count, while the review queue remains a separate historical/repair signal.
- Next action: Apply the migration through the normal deployment path, refresh Super Admin, and verify the count/oldest age against the extraction worker’s 24-hour behavior.

## 2026-09-09 — Standardize enrichment and semantic worker activity evidence

- Requested outcome: Continue TD-003 by making active non-extraction workers report meaningful work activity, not only liveness.
- Changes: Building enrichment and semantic embedding workers now publish the shared heartbeat metrics shape: cycle time, last work, last successful work, attempted, succeeded, and failed counts. Building enrichment now distinguishes successful and failed job results in its cycle stats; semantic indexing records preparation/provider/storage failures separately.
- Verification: Python compilation passed; `pytest -q tests/test_building_enrichment_worker.py` passed (`16 passed`); `pytest -q tests/test_semantic_embeddings.py` passed (`12 passed`); scoped `git diff --check` passed; Impeccable detector returned no findings for the affected admin page. Independent task-verifier verdict: PARTIAL because live heartbeat verification still requires redeployment.
- Deployment/push: Commit and push pending in this turn. Relevant services are `propai-lab:enrichment` and `semantic-embedding-worker`; no API, frontend, or extraction-reprocessing deployment is required.
- Limitations: The initial heartbeat can appear without activity metrics until the first worker loop heartbeat; no queue-depth query was added for these workers in this slice.
- Next action: Redeploy the two worker services, refresh Super Admin, and verify their activity lines change after a real cycle.

## 2026-09-09 — Add repair and matcher worker activity evidence

- Requested outcome: Continue TD-003 so the extraction-boundary repair worker and requirement matcher cannot appear operationally invisible in Super Admin.
- Changes: Added service-role heartbeats and shared cycle metrics to `extraction_repair_worker.py` and `matching/worker.py`. Repair metrics include attempted, completed, failed, and no-split jobs; matcher metrics include requirements scanned, match rows written, and requirements with matches. Super Admin renders matcher-specific cycle activity alongside the existing worker metrics.
- Verification: Python compilation passed; requirement-matching tests passed (`29 passed`); frontend production build passed for all 75 routes after the sandbox build retry; scoped `git diff --check` passed; Impeccable detector returned no findings. Independent task-verifier verdict: PARTIAL because live worker heartbeat and queue transition verification still require redeployment.
- Deployment/push: Commit and push pending in this turn. Relevant services are `matcher`, `tenant-boundary-repair-worker`, and `propai-lab:main-app`; no extraction-reprocessing or extraction-repair deployment is required.
- Limitations: Repair and matcher queue depth/oldest age are not yet included in the database snapshot; this slice makes cycle activity and errors visible first.
- Next action: Redeploy `matcher` and `tenant-boundary-repair-worker`, refresh Super Admin, and capture one real matching/boundary-repair cycle before closing TD-003.

## 2026-09-09 — Add tenant-boundary worker activity evidence

- Requested outcome: Include the deployed tenant-boundary repair worker in the truthful Super Admin worker-health contract.
- Changes: Confirmed Coolify resource `tenant-boundary-repair-worker` and added heartbeat metrics for attempted, repaired, and quarantined boundary repairs, with last-cycle/work/success timestamps and degraded-cycle errors.
- Verification: Python compilation and the existing requirement-matching suite remained green (`29 passed`); scoped diff checks passed. Independent task-verifier verdict: PARTIAL pending redeployment and live heartbeat verification.
- Deployment/push: Commit and push pending in this turn. Relevant service: `tenant-boundary-repair-worker`; the preceding matcher/UI commit also requires `matcher` and `propai-lab:main-app` redeployment.
- Limitations: Queue depth and oldest boundary-review age are not yet included in the database snapshot.
- Next action: Redeploy the confirmed Coolify worker, matcher, and dashboard, then verify all three live activity rows in Super Admin.

## 2026-09-09 — Make unified extraction schema-driven and preserve explicit broker detail

- Requested outcome: Make production extraction follow the eight typed table contracts and retain useful unstructured broker facts instead of losing fields such as built-up area, parking, floor, and JODI configuration.
- Changes: Expanded the active unified AI contract from a summary shape to the union of the eight route schemas; added preflight cues for area basis, parking, qualitative floor, furnishing, and combination-unit shorthand; added exclusive-source deterministic recovery for explicit `BU/BUA`, car-park, qualitative-floor, and `1+1 BHK Jodi` phrases with provenance; documented the invariant in `architecture.md`.
- Verification: Python compilation passed; preflight and typed extraction targeted tests passed (`4 passed`); the active prompt was checked to contain union-schema fields; scoped `git diff --check` passed. After installing the pinned `langgraph==0.6.8` into the existing `.venv`, the broader selected suite ran: `78 passed, 35 failed`. The failures are existing extraction-pipeline regressions/dirty-branch assumptions (including `apply_source_boundary` missing from the current working tree), so the independent task-verifier verdict remains PARTIAL rather than claiming a clean suite. Coolify deployment was independently confirmed finished on the exact commit, but a fresh field-by-field production smoke row is still pending.
- Deployment/push: Commit `4d143089` pushed to `origin/main`. Relevant service: `extraction-worker`; no database migration is required because the destination fields already exist. `propai-lab:main-app` is only needed if the audit UI is changed separately.
- Limitations: Recovery is intentionally conservative and only fills null fields from unambiguous text in the item’s exclusive source slice. It does not yet recover every possible broker abbreviation; live Sarvam output and the full test suite still need verification.
- Next action: Process one fresh eligible message containing BU area, parking, floor, and/or JODI shorthand, verify the typed row plus Extraction Activity provenance, then triage the 35 broader-suite failures separately without staging the user’s unrelated dirty files.

## 2026-09-09 — Harden source-authority edge cases

- Requested outcome: Continue the extraction acceptance work after installing the missing local test dependency.
- Changes: Restored the missing `apply_source_boundary` import used by the source-grounded route helper and made explicit money parsing tolerate broker punctuation such as `1.15.Cr`.
- Verification: Focused price-authority, preflight, and explicit-field tests passed; the broader selected suite now runs with `langgraph` installed and reports `79 passed, 34 failed`. The remaining failures are mixed legacy/current behavior expectations and unrelated extraction-pipeline regressions, not silently ignored. Scoped diff checks passed.
- Deployment/push: Commit `47ee64fd` pushed to `origin/main`. Coolify deployment `fdpy3fvy2t8z097ojfwfxr61` finished successfully, imported that exact commit, built a new image, and completed the rolling update for `extraction-worker`; no database migration is required.
- Limitations: Production is currently confirmed on the preceding unified-extraction commit `4d143089`; a fresh production field-by-field smoke row and a clean full extraction suite are still pending.
- Next action: Process one fresh eligible broker message, then verify persisted fields and source provenance in Extraction Activity.

## 2026-09-09 — Quarantine feature text misclassified as building identity

- Requested outcome: Review the first fresh post-deployment extraction and prevent broker feature lines from becoming building names.
- Changes: Expanded the shared building-name guard to reject balcony/terrace/view/ventilation and plural parking feature text. The observed `+ Balconies` sample now resolves to no building name with an explicit review flag rather than inventing an identity.
- Verification: Fresh production row confirmed the new schema fields were extracted (`3 BHK`, `1,180 carpet`, `2 parking`, `Multi Listing`, two detected blocks). Local exact-sample guard check returned `building_name=None` with `building_name_unresolved`; focused quality tests passed.
- Deployment/push: Commit `ffa719b5` pushed to `origin/main`. `extraction-worker` must be redeployed again for this guard to become live; no database migration is required.
- Limitations: The current row’s source slice does not contain a building name, so clearing it is correct; the full source evidence should remain available for a separate building-resolution/enrichment step.
- Next action: Redeploy `extraction-worker`, then verify a subsequent multi-listing row no longer stores feature text as its building identity.

## 2026-09-09 — Preserve shared building headers and qualitative floor fields

- Requested outcome: Correct multi-listing broadcasts where one building header applies to several unit blocks, and retain higher/lower/middle floor evidence.
- Changes: Listing source slices now carry only the named shared project header before the first property anchor; sibling unit facts are not copied. Preflight and source-only recovery now recognize higher, lower, middle, upper, top, ground, ordinal, and numbered floor labels with provenance.
- Verification: The representative Rustomjee broadcast now produces slices beginning with `Rustomjee Elita` for both child listings; floor recovery returns `higher floor` with provenance. Scoped checks passed (`3 passed, 17 deselected`) and `git diff --check` passed.
- Deployment/push: Commit `bc1843b7` pushed to `origin/main`. `extraction-worker` needs redeployment again; no database migration is required.
- Limitations: The shared-header rule applies only to a named prefix before the first BHK/property anchor; ambiguous headers remain unresolved rather than guessed.
- Next action: Redeploy `extraction-worker` and verify the next multi-listing extraction shows the shared building and floor values in the audit trace.

## 2026-09-09 — Preserve balcony facts while rejecting balcony-as-building errors

- Requested outcome: Keep balcony information because it is meaningful property data, while preventing `+ Balconies` from being saved as a building name.
- Changes: Source recovery now stores `balcony_present=true` with exact source provenance; Extraction Activity now displays Balcony as a relevant extracted field. The building guard remains limited to the building field only.
- Verification: Exact source recovery returned balcony presence plus floor provenance; frontend production build completed successfully for all 75 routes; scoped diff checks passed.
- Deployment/push: Commit `7544f862` pushed to `origin/main`. Redeploy `extraction-worker` and `propai-lab:main-app`; no database migration is required.
- Limitations: The current legacy row will not change automatically; the correction applies to new/reprocessed extractions within the configured 24-hour window.
- Next action: Redeploy both services and verify a fresh multi-listing row shows the shared building, floor type, and balcony fact separately.

## 2026-09-09 — Add source-grounded property intelligence layer

- Requested outcome: Preserve richer broker detail beyond the fixed typed fields so PropAI can build intelligence rather than only a generic parser.
- Changes: Added a bounded `property_intelligence` contract to the active extraction prompt and normalizer, grouped into unit features, building features, pricing terms, access/rules, location context, relationships, and unresolved mentions. Every retained entry requires item-local source wording. The payload is copied into `ai_extraction` and `unstructured_facts`, and the Extraction Activity view now shows it with source text. Boolean fields such as Balcony render as Yes/No in the audit UI.
- Verification: Focused extraction tests passed (`2 passed`); frontend production build completed successfully for all 75 routes; scoped `git diff --check` passed.
- Deployment/push: Code and architecture changes are ready to commit and push in this turn. Relevant services after push: `extraction-worker` and `propai-lab:main-app`; no database migration is required because existing JSONB destinations are used.
- Limitations: Existing rows are not reprocessed automatically and will not gain the new payload outside the configured 24-hour window. This is an additive evidence layer; future dedicated searchable fields still need explicit schema work.
- Next action: Commit/push, redeploy the worker and dashboard, then verify a fresh multi-listing row shows balconies, floor qualifiers, relationships, and source quotations in Extraction Activity.
- Independent verifier verdict: PARTIAL. Local persistence, normalization, admin rendering, focused tests, and production build are verified; the worker and dashboard have not yet been redeployed on `3adba3d0`, and no fresh live row has confirmed the new payload. Exact next action: redeploy `extraction-worker` and `propai-lab:main-app`, then inspect one fresh multi-listing extraction in Super Admin.

## 2026-09-09 — Remove extraction write admission gate

- Requested outcome: Let source-grounded extraction rows persist even when an optional broker identity field is unsupported, instead of dropping the entire opportunity at the review gate.
- Changes: `save_typed_observation` now treats the legacy `write_blocked` signal as review metadata. The unsupported field remains quarantined, the row is saved, and a durable validation flag records that the former gate was bypassed. Tenant, dedupe, source-boundary, and publication-safety controls remain unchanged.
- Verification: `storage/supabase.py` compiled; focused broker-grounding and write-policy tests passed (`8 passed, 10 deselected`); scoped `git diff --check` passed.
- Deployment/push: Commit `77d1a7ea` pushed to `origin/main`. Relevant service: `extraction-worker`; no database migration is required. Existing rows are not reprocessed outside the configured 24-hour window.
- Limitations: `needs_review` remains visible for audit and may still affect matching/review workflows; this change removes the hard extraction persistence stop, not every downstream quality signal. The screenshots also show a separate title-quality/prompt issue that should be fixed independently.
- Next action: Redeploy `extraction-worker`, then verify one fresh row with an unsupported broker name is present in the typed table and still visibly flagged in Extraction Activity.

## 2026-09-09 — Make dedupe evidence complete and navigable

- Requested outcome: Make the dedupe admin evidence useful beyond the first 100 rows, show why rows are linked, and make repost/freshness behavior inspectable for cases such as Eternity and Gurukrupa.
- Changes: Added offset pagination and filtered totals to `/api/admin/dedupe-gate`; redesigned the page metrics to distinguish linked duplicates, exact reposts stopped, and classification gaps; added page navigation and corrected misleading sample wording. The source-block path for Gurukrupa remains a separate pre-extraction control and does not retroactively remove already-typed historical rows.
- Verification: `routers/admin.py` compiled; frontend production build completed successfully with all 75 routes; scoped `git diff --check` passed.
- Deployment/push: Code is ready to commit and push. Relevant services: `api` and `propai-lab:main-app`; no database migration is required for pagination.
- Limitations: The charts summarize the loaded page while the headline totals cover the full matching set; full-dataset grouped charts would require a separate aggregate endpoint. Exact Eternity/Gurukrupa row-level diagnosis still requires the raw IDs or a live API query after deployment.
- Next action: Redeploy `api` and `propai-lab:main-app`, page through the dedupe history, then inspect the Eternity row and confirm whether Gurukrupa is a source-block case or a pre-existing typed-row cleanup case.

## 2026-09-09 — Isolate named market-feed offers and simplify cards

- Requested outcome: Stop a card's applicable evidence from including neighbouring offers, prevent repeated locality context in titles, show micro-locations such as Mount Mary/Pali Hill as chips, and keep full WhatsApp evidence behind the disclosure.
- Changes: The source resolver now treats `4BHK FOR RENT`-style lines as configuration headers and uses the named building offer as the item boundary; added regression coverage for the Raheja Bay broadcast. Market Inbox cards now derive micro-location chips from landmark/sub-locality/raw parenthetical context, fall back to a clean source-grounded title when the stored title repeats location context, use `for rent/sale in ...` wording, and no longer render an inline raw-evidence preview.
- Verification: Focused source-boundary suite passed (`7 passed`); Python compilation passed; frontend production build passed with all 75 routes; scoped `git diff --check` passed. Independent verifier verdict: PASS for local implementation, with deployment still pending.
- Deployment/push: Commit `c5104778` pushed to `origin/main`. Relevant services after push: `api` (source evidence resolver), `propai-lab:main-app` (card presentation), and `extraction-worker` only if newly extracted source slices/titles must use the updated source-boundary/title behavior; no database migration is required.
- Limitations: The Raheja block contains two rent quotes but does not explicitly identify two separate units, so it remains one card with both quotes preserved. Existing typed rows will not be re-extracted outside the configured 24-hour window; the corrected evidence display applies immediately where the raw message is available.
- Next action: Redeploy `api` and `propai-lab:main-app`, then verify the Raheja Bay card shows only its own excerpt and Mount Mary as a chip.

## 2026-09-09 — Enrich listing detail and correct explicit lakh rent quotes

- Requested outcome: Make market listing detail pages useful from the full typed extraction, preserve the exact per-listing evidence, and prevent broker quotes such as `4 lac` from becoming `₹40,000`.
- Changes: Expanded the detail page across deal, property, amenity, preference, and contact fields; added micro-location chips; show the exact source slice first and full WhatsApp evidence behind a disclosure. Corrected the typed-detail source projection to prefer `slice_text`. Added source-grounded rent recovery for isolated slices with one explicit quote and correction when the AI value differs materially; mixed broadcasts still fail closed.
- Verification: Explicit rent regression tests passed (`4 passed`); Python compilation and scoped diff checks passed; production frontend build passed with placeholder build credentials and all 75 routes. A broader extraction test collection remains blocked in this checkout by the missing `langgraph` package during `app.py` import. Independent task-verifier verdict: PARTIAL until deployment and a fresh live row are verified.
- Deployment/push: Code is ready to commit and push. Relevant services after push: `extraction-worker` (price correction) and `api` plus `propai-lab:main-app` (detail API/projection and UI); no database migration is required.
- Limitations: Existing rows are not reprocessed outside the configured 24-hour window. The current screenshot row will need a fresh eligible extraction to prove the corrected amount in production; historical data remains unchanged.
- Next action: Commit/push, redeploy the three relevant services, then inspect one fresh listing detail and one source containing `4 lac`/`4 lakh` to confirm the typed amount, broker quote, and full evidence.

## 2026-09-09 — Separate quality flags from the write gate and suppress exact child duplicates

- Requested outcome: Explain and fix why `Review needed` remained visible, why one WhatsApp broadcast could create repeated cards, and why the Dedupe Gate page returned 503.
- Changes: Exact duplicate AI child items with identical normalized source slices are now collapsed before typed persistence; distinct source slices remain separate. Dedupe admin count queries now run sequentially because the shared synchronous Supabase client was being used concurrently from multiple threads. Extraction Activity labels `needs_review` as `Quality flag` so it is clear that rows are saved, not blocked.
- Verification: Exact-duplicate and price regression tests passed (`3 passed`); Python compilation and scoped diff checks passed; frontend production build completed all 75 routes. Independent verifier verdict: PARTIAL until production redeployment and a live MARINA BAY/Dedupe Gate check.
- Deployment/push: Code is ready to commit and push. Relevant services: `extraction-worker` (child-item suppression), `api` (Dedupe Gate endpoint), and `propai-lab:main-app` (quality label); no database migration is required.
- Limitations: The suppression is intentionally exact-source only and will not merge two distinct apartments merely because their building/BHK/price match. Existing duplicate typed rows are not removed automatically.
- Next action: Redeploy the three services, confirm `/admin/pipeline-health?tab=dedupe` loads, and inspect a new MARINA BAY broadcast to verify one card per distinct source slice.

## 2026-09-09 — Repair market evidence slices, BHK recovery, and named-villa titles

- Requested outcome: Make Market Inbox show the applicable broker block rather than a heading-only excerpt, recover BHK where the source contains one unambiguous configuration, and prevent a building name such as `Devansh Villa` from becoming a villa property type.
- Changes: The market feed now fetches bounded raw message text for its typed rows and resolves the applicable source block through the shared evidence resolver. Older heading-only slices can therefore show the complete item-local block while the full broadcast remains available behind the disclosure. Missing BHK is recovered at read time only when the resolved block has one unambiguous BHK, and the extraction fallback now accepts one explicit BHK in a complete message. Inbox title generation strips villa as a property-type label when it appears only inside the named building identity.
- Verification: Focused source-boundary, named-villa, evidence, and BHK recovery tests passed (`36 passed`); Python compilation passed; frontend production build completed all 75 routes; staged diff check passed; Impeccable detector returned no findings.
- Deployment/push: Commit `b4b1aa8a` is pushed to `origin/main`. Relevant services: `api` (raw evidence projection), `extraction-worker` (new BHK recovery), and `propai-lab:main-app` (title guard). No database migration is required. Redeployment and live-row verification remain pending.
- Limitations: Existing typed rows are not rewritten outside the configured 24-hour window; the API read projection repairs their displayed evidence/BHK when the raw message is available, while persisted historical fields remain unchanged. A live Supabase management query was unavailable because the local management token was unauthorized.
- Next action: Redeploy `api`, `extraction-worker`, and `propai-lab:main-app`, then verify a Palm Crest/Devansh Villa card shows its item block, BHK, and apartment-style title.
- Independent verifier verdict: PARTIAL. Local code paths and tests pass, but production deployment and a fresh live-row check have not yet been performed.

## 2026-09-09 — Make enriched building identity authoritative before extraction

- Requested outcome: Resolve known names such as `Sethia Sea View` as buildings before AI extraction, and prevent names such as `Devansh Villa` from being interpreted as a villa property type.
- Changes: The pre-AI building context now includes tenant-scoped canonical buildings as well as aliases. The extraction bridge now applies the existing canonical building matcher before title generation and persistence. This closes the gap where enrichment existed in the database but was not consulted as an identity authority.
- Verification: Python compilation passed; the focused source/evidence/title suite passed (`36 passed`); `git diff --check` passed.
- Deployment/push: Commit `a885e89d` pushed to `origin/main`. Relevant services: `extraction-worker` and `api`; redeployment and a fresh live-row check remain pending. No migration is required.
- Limitations: Existing rows are not rewritten outside the 24-hour extraction window. The canonical shortlist is cached per tenant for the worker cache lifetime.
- Next action: Redeploy `extraction-worker` and `api`, then verify a new Sethia Sea View row resolves the building and a Devansh Villa row remains an apartment/property title rather than villa type.
- Independent verifier verdict: PARTIAL until production redeployment and fresh live-row verification.

## 2026-09-10 — Normalize lease quotes and remove stale parking placeholders

- Requested outcome: Stop lease quotes such as `1.50 LACS` from displaying as ₹15 lakh/month and prevent old provider parking placeholders from appearing when the source has no parking evidence.
- Changes: Rental/lease routes now source-correct `one_time` to `per_month` when the source explicitly says lease/rent/quote and does not say sale. Rental normalization preserves `1.50 LACS` as ₹1,50,000. Legacy `parking_details.key` placeholders are removed in both worker recovery and parsed conversion paths.
- Verification: Focused extraction/preflight/villa/shorthand tests passed (`11 passed`); Python compilation and scoped `git diff --check` passed.
- Deployment/push: Commit `f4a70f72` pushed to `origin/main`. Relevant service: `extraction-worker`; API/internal dashboard read-time path also needs redeployment for the stale-row display behavior. No migration is required.
- Limitations: Existing rows remain unchanged outside the 24-hour window. `QUOTE` without a rental/lease context is not reinterpreted as monthly.
- Next action: Redeploy `extraction-worker` and the API/internal app, then verify a fresh Bandra lease quote displays ₹1.5 lakh/month and no placeholder parking object.
- Independent verifier verdict: PARTIAL until production redeployment and fresh live-row verification.

## 2026-09-09 — Make extraction preflight item-scoped

- Requested outcome: Rectify the extraction pipeline so document-level broadcast cues do not cut individual AI extraction items short or cross-wire fields, while preserving rich source-grounded commercial facts.
- Outcome: Partial pending deployment and live verification. The permanent code path is implemented and pushed; the local full application suite remains blocked because this checkout's Python environment still cannot import `langgraph`.
- Changes: `preflight_classifier.py` now supports exclusive source-block classification; `extraction.py` stores item-level preflight separately from document-level preflight and recovers explicit commercial use, deposit months, parking, and suitable-for facts from the item slice; `extraction_quality.py` quarantines `Location: ...` as a building; `ai_extraction.py` explicitly instructs the model to re-evaluate cues per item; `architecture.md` records the invariant; focused regressions were added.
- Verification: Focused item-scoped, preflight, source-boundary, and villa tests passed (`14 passed`, then `8 passed` after final staging); Python compilation passed; scoped `git diff --check` passed. Full extraction collection could not be collected: `ModuleNotFoundError: No module named 'langgraph'`.
- Deployment/push: Commit `1a344ce1` pushed to `origin/main`. Relevant service: `extraction-worker`; no database migration is required. Redeploy was not performed by this task.
- Limitations/failures: Existing rows remain unchanged outside the configured 24-hour window. Production behavior has not yet been verified with a fresh showroom/broadcast row. The local environment needs its declared Python dependencies installed before the full application suite can run.
- Next action: Redeploy `extraction-worker`, process a fresh multi-listing commercial message, and verify item-level preflight plus `building_name=null` for road/location-only entries and preservation of use, deposit, parking, and suitable-for facts.
- Independent verifier verdict: PARTIAL. The code path and focused acceptance tests pass; full collection and production verification remain outstanding.

## 2026-09-09 — Stop furnishing labels becoming localities

- Requested outcome: Debug the fresh `Metro Police - Furnished` extraction where the building was correct but `Furnished` appeared as the locality.
- Changes: The parsed bridge now applies source-locality grounding and rejects furnishing/property-type labels after a building dash as locality candidates. Explicit source locality lines remain authoritative. Added a regression for the exact Metro Police shape.
- Verification: New locality regression plus the prior area, source, BHK, title, and evidence suites passed (`39 passed`). The wider regression file still contains an unrelated pre-existing crore-price failure (`₹1.85 Cr` currently becoming `₹18.5L`).
- Deployment/push: Commit `b925b892` pushed to `origin/main`. Relevant service: `extraction-worker`; this latest fix needs redeployment and a fresh row check. No database migration is required.
- Limitations: Existing typed rows are not rewritten outside the configured 24-hour window. The fix prevents known non-locality labels from becoming locations; it does not invent a locality when the source does not contain one.
- Next action: Redeploy `extraction-worker`, then verify a fresh `Metro Police - Furnished` row has `locality=null` while retaining `building_name=Metro Police`.
- Independent verifier verdict: PARTIAL until the latest commit is deployed and live-verified.

## 2026-09-09 — Quarantine tenant rules from building identity

- Requested outcome: Correct the Marina Bay broadcast where `Only vegetarian Client` was persisted as the building, despite `MARINA BAY` being the shared broadcast header.
- Changes: Added tenant-rule building guards for vegetarian/non-vegetarian, family, bachelor, corporate, and company client/tenant phrases. When the bad candidate is removed, the existing shared-header resolver can retain `MARINA BAY`; `WORLI` remains the locality and the tenant rule stays in broker/property intelligence.
- Verification: New Marina Bay regression plus locality, area, source, BHK, title, and evidence suites passed (`40 passed`); scoped diff check passed.
- Deployment/push: Commit `7101f0ae` pushed to `origin/main`. Relevant service: `extraction-worker`; latest commit needs redeployment and a fresh Marina Bay row check. No database migration is required.
- Limitations: Existing typed rows are not rewritten outside the configured 24-hour window.
- Next action: Redeploy `extraction-worker`, then verify the fresh row shows `MARINA BAY` as building, `WORLI` as locality, and `Only vegetarian Client` only as a tenant preference.
- Independent verifier verdict: PARTIAL until the latest commit is deployed and live-verified.

## 2026-09-09 — Resolve noisy `Metro Police` building text to `Metropolis`

- Requested outcome: Preserve the actual enriched building identity when Sarvam mis-transcribes `Metropolis` as `Metro Police`; do not treat the noisy value as a new building.
- Changes: Added a conservative compact-name similarity path to the enrichment-backed building matcher. Strong spelling/spacing noise can now resolve to an existing canonical building, while unknown names are still not invented. The regression confirms `Metro Police` resolves to `Metropolis` and does not become locality text.
- Verification: New building/locality regression plus prior area, source, BHK, title, and evidence suites passed (`39 passed`); scoped diff check passed.
- Deployment/push: Commit `978cacfc` pushed to `origin/main`. Relevant service: `extraction-worker`; the latest commit needs redeployment and a fresh row check. No database migration is required.
- Limitations: Resolution only occurs when the canonical building is already present in the tenant-scoped enrichment registry. Existing rows remain unchanged outside the 24-hour window.
- Next action: Redeploy `extraction-worker`, then verify a fresh row displays `Metropolis` as the building and no locality derived from `Furnished`.
- Independent verifier verdict: PARTIAL until the latest commit is deployed and live-verified.

## 2026-09-09 — Expand explicit dual rent/sale price offers

- Requested outcome: A source line containing both a rent quote and a sale quote must create two queryable typed opportunities, each with its own transaction type and price.
- Changes: Added deterministic detection for price-attached forms such as `₹2.25L Rent / ₹5 Cr Sale`. The expansion now creates separate sale and rent rows, assigns `₹5 Cr` to sale and `₹2.25L/month` to rent, sets `listing_count=2`, marks both rows with `dual_transaction_expanded`, and keeps the AI payload transaction types aligned with the typed rows.
- Verification: The new regression passed for the Parinee I form; Python compilation passed. The broader combination test collection still contains pre-existing unrelated title expectation failures in this dirty checkout.
- Deployment/push: Commit `aa3f5107` pushed to `origin/main`. Relevant service: `extraction-worker`; redeployment and live verification remain pending. No migration is required.
- Limitations: Existing rows are not reprocessed outside the configured 24-hour window. A retry is not needed when both explicit prices are present because deterministic expansion is source-grounded and cheaper than a second model call.
- Next action: Redeploy `extraction-worker`, then verify Parinee I produces one sale card at ₹5 Cr and one rent card at ₹2.25L/month.
- Independent verifier verdict: PARTIAL until production redeployment and a fresh dual-transaction row are verified.

## 2026-09-09 — Correct PSF period labels and commercial area ranges

- Requested outcome: Prevent PSF rates from displaying as monthly rent and preserve commercial area ranges as structured data.
- Changes: PSF prices now discard an invalid inherited monthly period and titles display the broker’s PSF wording. Explicit ranges such as `9,500 / 12,500 Carpet` now populate `area_min_sqft`, `area_max_sqft`, and source provenance.
- Verification: Three focused regression tests passed; Python compilation and scoped diff checks passed.
- Deployment/push: Commit `ea70a964` pushed to `origin/main`. Relevant services: `extraction-worker`, `api`, and `propai-lab:main-app`; redeployment and live verification remain pending. No migration is required.
- Limitations: Existing historical typed rows are not rewritten outside the 24-hour window.
- Next action: Redeploy the relevant services and verify the Andheri East PSF card displays `₹250 PSF`, not `₹250/month`, with the area range preserved.
- Independent verifier verdict: PARTIAL until production redeployment and a fresh live-row check.

## 2026-09-09 — Preserve composite commercial areas and request range fields

- Requested outcome: Continue comparing Sarvam responses with source slices and prevent useful commercial facts from being lost or structurally misrepresented.
- Changes: Commercial rent extraction now explicitly requests `area_min_sqft` and `area_max_sqft`. Composite forms such as `600 + 360 Loft` are source-guarded so the loft is stored as `mezzanine_area_sqft`, the raw wording is preserved, and no false 960 sqft carpet/chargeable total survives.
- Verification: Focused source, BHK, title, evidence, PSF, and area tests passed (`39 passed`); scoped `git diff --check` passed.
- Deployment/push: Commit `4253f3f0` pushed to `origin/main`. Relevant service: `extraction-worker`; redeployment and fresh live-row verification remain pending. No database migration is required.
- Limitations: Existing rows are not rewritten outside the configured 24-hour window. A primary area without an explicit basis remains raw rather than being guessed into carpet/built-up/chargeable fields.
- Next action: Redeploy `extraction-worker`, then verify a fresh Parinee-style composite commercial row and an Andheri East range row in the typed output.
- Independent verifier verdict: PARTIAL until production redeployment and fresh live-row verification.

## 2026-09-10 — Harden broker shorthand and stale extraction diagnostics

- Requested outcome: Preserve shorthand such as `1cp`, prevent provider null sentinels from leaking into titles, and make old extraction traces show item-scoped preflight diagnostics.
- Changes: `extraction.py` now source-grounds `cp` parking shorthand and removes the legacy parking placeholder; `ai_extraction.py` documents the real parking-details contract and strips terminal `None`/`null` title sentinels; `storage/supabase.py` recomputes stale zero-block preflight metadata from the stored item slice at read time without rewriting production rows.
- Verification: Focused item-scoped, preflight, villa, shorthand-parking, and title-normalization tests passed (`10 passed`); Python compilation and scoped `git diff --check` passed. The broader selected extraction suite previously ran under the local `.venv` with `106 passed, 35 failed`; those failures include pre-existing dirty-worktree expectations and require separate cleanup.
- Deployment/push: Commit `a2c8ac67` pushed to `origin/main`. Relevant services: `extraction-worker` and `api`/`propai-lab:main-app` for the read-time trace path. Redeployment and fresh live-row verification are pending; no migration is required.
- Limitations: Existing typed rows are not reprocessed outside the configured 24-hour window. A missing source price remains `Price not found`; this fix does not invent one. The source phrase `Lease` remains semantically distinct even if the legacy rent route is used for typed-table compatibility.
- Next action: Redeploy the extraction worker and API/dashboard path, then verify a fresh `1cp` lease row, a no-price row, and an old trace now show structured parking, no literal `None`, and item-scoped preflight.
- Independent verifier verdict: PARTIAL until production redeployment and fresh live-row verification.

## 2026-09-10 — Keep homepage listings independent from locality aggregation

- Requested outcome: Fix the public homepage showing a live ticker item while the main inventory section incorrectly showed no live listings.
- Changes: `apps/www/src/app/page.tsx` now loads the listing overview independently from the locality directory and building scan. A slow or failed locality aggregation can no longer replace a healthy listing overview with the homepage empty state.
- Verification: Production read-only endpoint `/api/latest-listings?offset=0&limit=6` returned six live listings while the reported homepage state was empty; the local www production build completed successfully with Next.js 16.2.9; scoped `git diff --check` passed.
- Deployment/push: Local change implemented; deployment was not performed. Relevant service: `propai-lab:main-app`. Push status and commit are pending this task.
- Limitations: Live production homepage verification after deployment remains pending. If the listing query itself fails, the homepage still fails closed rather than fabricating inventory.
- Next action: Commit and push this homepage isolation fix, then redeploy `propai-lab:main-app` and verify the homepage grid, ticker, and locality section independently.
- Independent verifier verdict: PASS for the local implementation and build; production redeployment/live verification remains pending.

## 2026-09-10 — Prevent duplicate lakh scaling in public prices

- Requested outcome: Stop a corrupted public price such as `₹85000 Cr` from appearing when the broker/provider output contains `₹85,00,000 Lakhs`.
- Changes: The shared price normalizer now treats Indian comma-grouped rupee amounts followed by a redundant lakh/lac label as absolute rupees. Public card, homepage overview, and live ticker formatting also guard existing malformed rows using the same source text.
- Verification: New normalization regression passed (`1 passed, 45 deselected`); www production build passed with Next.js 16.2.9; scoped `git diff --check` passed. The broader listing-card test runner reaches a pre-existing unrelated title expectation failure (`Semi Furnished Property` vs `Semi-Furnished 3 BHK`).
- Deployment/push: Local change implemented; deployment was not performed. Relevant services: `extraction-worker` for new rows and `propai-lab:main-app` for public read-time protection. Push status and commit are pending this task.
- Limitations: The malformed historical database value is not rewritten by this code change; public display is corrected from the retained raw price text. A reviewed data repair can be run separately if the stored row itself must be corrected.
- Next action: Commit and push the scoped fix, redeploy the extraction worker and public site, then verify the Salim Villa card/ticker displays the source-grounded lakh amount.
- Independent verifier verdict: PARTIAL until production redeployment and live verification.

## 2026-09-10 — Show BHK facts and disclose public feed scope

- Requested outcome: Make residential cards visibly show BHK details, including an icon, and make the public feed’s coverage boundary explicit.
- Changes: Public listing titles now retain structured BHK text instead of replacing it with “Residential property”. Cards add a prominent bed icon/BHK chip. The homepage now passes the first 60 rows to its incremental loader instead of only six and states that the grid is a freshest-record view.
- Verification: Impeccable detector returned no findings for the changed UI targets; www production build passed with Next.js 16.2.9; scoped `git diff --check` passed. Existing listing-card tests still contain an unrelated pre-existing title expectation failure.
- Deployment/push: Local change implemented; deployment was not performed. Relevant service: `propai-lab:main-app`. Push status and commit are pending this task.
- Limitations: The public overview currently fetches at most 200 recent rows from its four-table snapshot, so this change discloses the scope but does not yet provide cursor pagination across the full inventory.
- Next action: Commit and push the UI/scope disclosure fix, redeploy `propai-lab:main-app`, then implement a shared cursor-paginated public inventory query for complete browsing.
- Independent verifier verdict: PARTIAL because the local UI/build acceptance conditions pass, but the feed remains capped and production verification is pending.

## 2026-09-10 — Normalize compact furnishing labels on public cards

- Requested outcome: Render compact stored furnishing values as readable public chips, e.g. `semifurnished` as `Semi-furnished` and `fullyfurnished` as `Fully furnished`.
- Changes: `apps/www/src/components/LatestListingsGrid.tsx` now normalizes compact, underscored, and hyphenated furnishing values before rendering the card chip.
- Verification: Impeccable detector returned no findings; the www production build passed with Next.js 16.2.9; scoped `git diff --check` passed.
- Deployment/push: Local change implemented; deployment was not performed. Relevant service: `propai-lab:main-app`. Push status is pending this task.
- Limitations: This is a display normalization fix; it does not rewrite historical database values or address the separate public-feed pagination cap.
- Next action: Redeploy `propai-lab:main-app` and verify representative semi-furnished and fully furnished cards in production.
- Independent verifier verdict: PARTIAL: local implementation and build pass; production redeployment/live verification remains pending.

## 2026-09-10 — Restore public locality directory and city context

- Requested outcome: Restore the public `/localities` page, keep locality results visible, and show the connected city context instead of a server-error screen.
- Changes: The locality index now uses the live aggregate counts directly instead of issuing one full listing query per locality, preventing one failed locality query from crashing the entire page. Aggregate RPC exceptions are caught so the bounded direct-query fallback can run. The page also shows the current connected city as `Mumbai`.
- Verification: Repository-local UI detector returned no findings for the changed page; www production build passed with Next.js 16.2.9; scoped `git diff --check` passed.
- Deployment/push: Local change implemented; deployment was not performed. Relevant service: `propai-lab:main`. Push status is pending this task.
- Limitations: Mumbai is currently the only connected city represented by the public inventory, so the city control is contextual rather than a multi-city switcher. Live production verification remains pending.
- Next action: Redeploy `propai-lab:main`, then reload `/localities` and confirm the locality cards and Mumbai context render.
- Independent verifier verdict: PARTIAL: local implementation and build pass; production redeployment/live verification remains pending.

## 2026-09-10 — Separate building rent/sale ranges and recover unlinked detail rows

- Requested outcome: Prevent public building cards from showing a rent-to-sale price range and ensure a building page does not show zero listings when live locality inventory exists but historical building links are missing.
- Changes: `get_locality_summary` now returns transaction-specific rent and sale price bounds; public cards and map popovers render those separately. Building detail queries now fall back to exact building-name plus canonical-locality matching only when the immutable building-link path returns no rows.
- Verification: Production Supabase RPC returned 29 Serendipity rows with separate values (`rent_min/max_price=550000`, `sale_min/max_price=75800000`). www production build passed with Next.js 16.2.9; Impeccable detector returned no findings; scoped `git diff --check` passed.
- Deployment/push: Migration `20260910033000_separate_public_building_price_ranges.sql` applied to production with HTTP 201. Application code is committed locally but public-site redeployment is pending. Relevant service: `propai-lab:main`.
- Limitations: Existing public pages remain on the deployed application version until Coolify redeploys. The fallback is intentionally exact-name and locality-scoped; it does not repair missing building links in the database.
- Next action: Commit and push the scoped application/migration/report changes, redeploy `propai-lab:main`, then verify `/localities/bandra-east` and `/buildings/serendipity` show separate rent/sale prices and the 29 live rows.
- Independent verifier verdict: PARTIAL until the public site is redeployed and the two live pages are rechecked.

## 2026-09-10 — Remove AI sparkle icons from public www UI

- Requested outcome: Do not use AI star/sparkle-style icons anywhere on the public website.
- Changes: Replaced the locality directory’s sparkle marker with plain data text and replaced the natural-search sparkle with a neutral search icon. Internal dashboard AI indicators were not changed.
- Verification: No `Sparkles`/`Sparkle` component references remain in `apps/www/src`; Impeccable detector returned no findings for the changed pages; www production build is being verified in this task.
- Deployment/push: Local change only; deployment was not performed. Relevant service: `propai-lab:main`.
- Limitations: Star-like emoji present inside broker-supplied source text comments/evidence are data, not UI icons, and were not altered.
- Next action: Commit and push, then redeploy `propai-lab:main` and visually check `/`, `/search`, `/localities`, listing cards, and building pages.
- Independent verifier verdict: PARTIAL until production redeployment and visual confirmation.

## 2026-09-10 — Deterministic Auto Matched engine

- Requested outcome: Implement Auto Matched without an LLM, with broker-customizable requirement rules and scheduled matching.
- Changes: Added persisted per-requirement thresholds, caps, freshness/tolerance settings, unknown-field controls, cadence, and enablement. The matcher now hard-rejects tenant/type/status/location/BHK/budget conflicts, preserves separate units in the same building, stores explainable reasons/unknown fields, and runs due requirements through the matcher worker. Added manual “Run matching now” and minimum-score controls to the internal Auto Matched page.
- Files/services: `matching/requirement_listing_matcher.py`, `matching/service.py`, `matching/worker.py`, `routers/auto_matched.py`, `frontend/src/app/auto-matched/page.tsx`, `frontend/src/lib/api.ts`, `supabase/migrations/20260910090000_requirement_match_preferences.sql`, `tests/test_requirement_listing_matching.py`, and `architecture.md`.
- Verification: Focused matcher tests passed 7/7; Python compilation passed; frontend `NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder npm run build` passed; scoped `git diff --check` passed. Production migration applied with HTTP 201 and schema query confirmed the preference table plus explanation columns.
- Deployment/push: Migration applied; application/worker deployment not performed. Relevant Coolify services: `api`, `propai-lab:main-app`, and `matcher`. Push status is pending this task.
- Limitations: Live end-to-end save → worker → UI verification remains pending until the three services are redeployed. Manual run currently processes the bounded requirement/listing query windows already used by the matcher.
- Next action: Commit and push the scoped changes, redeploy `api`, `propai-lab:main-app`, and `matcher`, then verify a requirement with one matching and one conflicting listing in Auto Matched.
- Independent verifier verdict: PASS for the requested local implementation and applied schema; live deployment verification is explicitly pending and not represented as complete.

## 2026-09-10 — Broker approval bridge and client match buckets

- Requested outcome: Make Auto Match broker-controlled: My Deals records require approval, brokers can curate client listing/requirement buckets, and requirements can explicitly allow multiple canonical localities.
- Changes: Added `matching_item_approvals`, `match_buckets`, and `match_bucket_items` with tenant-scoped RLS and typed source identities. My Deals now exposes an `Approve for Auto Match` action and approval state. The matcher requires approved requirements and listings, respects private versus shared-market visibility, and retains deterministic multi-locality behavior. Added bucket/approval API routes and documented the source/visibility contract.
- Verification: Focused matcher tests passed 7/7; Python compilation passed; frontend production build passed with placeholder Supabase variables; scoped diff checks passed; production migration applied with HTTP 201 and verified all three new tables.
- Deployment/push: Production migration applied. Application and matcher redeployment not performed. Relevant services: `api`, `propai-lab:main-app`, and `matcher`. Push status is pending this task.
- Limitations: The backend bucket primitives and My Deals approval action are implemented; a dedicated bucket-management panel and client selector UI should be the next UX slice. Existing records remain unapproved until a broker explicitly approves them, so zero matches is expected until that action is used.
- Next action: Commit and push the scoped changes, redeploy `api`, `propai-lab:main-app`, and `matcher`, then approve one My Deals listing and requirement and verify a match, including a multi-locality requirement.
- Independent verifier verdict: PARTIAL: approval-gated matching and schema are implemented and locally/production-schema verified; full bucket UI and live end-to-end deployment verification remain pending.

## 2026-09-10 — Live relational building intelligence

- Requested outcome: Build a reliable relational intelligence layer from existing mapped buildings and listings, without another Google API or LLM, and keep it current as inventory changes.
- Changes: Added `get_public_building_relational_intelligence(building_id)`, a live 30-day SQL read model over the existing public projections. It returns building supply, rent/sale-separated price bounds, configuration mix, fresh activity, broker coverage, locality totals, and nearby buildings within 1km using stored coordinates. The public building page now renders this observed context and nearby captured supply.
- Files/services: `supabase/migrations/20260910120000_public_building_relational_intelligence.sql`, `apps/www/src/lib/building-intelligence.ts`, `apps/www/src/app/buildings/[slug]/page.tsx`, and `architecture.md`.
- Verification: www production build passed with Next.js 16.2.9; scoped `git diff --check` passed; production migration applied with HTTP 201; production RPC returned non-null for Amin Alturas. The RPC is live-read based, so no refresh worker or copied listing table is required.
- Deployment/push: Migration applied to production. Commit `02c792c2` was pushed to `origin/main`. Public application deployment was not performed. Relevant service: `propai-lab:main`.
- Limitations: The detailed production aggregate response was too slow for the management-query client to return in the final diagnostic, although the bounded non-null RPC check passed. Public UI verification after redeployment remains pending.
- Next action: Commit and push the scoped changes, redeploy `propai-lab:main`, then verify a building page shows observed context and nearby buildings.
- Independent verifier verdict: PARTIAL: implementation, build, migration, and bounded production RPC check pass; public redeployment and visual verification remain pending.

## 2026-09-10 — Deterministic public collections and requirement buckets

- Requested outcome: Generate public listing buckets automatically from live supply and use broker requirements as proper deterministic private buckets, without manual assembly, LLM decisions, or a duplicate inventory table.
- Changes: Added `public_listing_collections` and typed listing-reference items with RLS and safe public projections. Added `public_collections_worker.py` and its worker image; it generates factual locality/transaction/BHK market slices, ranks rows by freshness/completeness, stores reproducible reason codes, archives underfilled/stale slices, and keeps only 3–24 fresh items. The www site now exposes `/collections` and `/collections/[slug]`. The existing deterministic matcher now maintains one private generated listing bucket per approved requirement from its authoritative match rows.
- Files/services: `supabase/migrations/20260910140000_deterministic_public_collections.sql`, `public_collections_worker.py`, `Dockerfile.public-collections-worker`, `matching/service.py`, `apps/www/src/lib/collections.ts`, `apps/www/src/app/collections/page.tsx`, `apps/www/src/app/collections/[slug]/page.tsx`, `tests/test_public_collections_worker.py`, and `architecture.md`.
- Verification: Collection and matcher tests passed 9/9; Python compilation passed; www production build passed with Next.js 16.2.9; scoped `git diff --check` passed; production migration applied with HTTP 201; production schema query confirmed both collection tables.
- Deployment/push: Migration applied to production. Commit `f0e4383b` was pushed to `origin/main`. The application and new collection worker have not been deployed. Relevant services: `propai-lab:main` and a new `public-collections-worker` Coolify resource.
- Limitations: Until the worker is deployed and runs once, `/collections` will correctly show no live collections rather than dummy content. Requirement buckets are generated only for approved requirements when the matcher runs; private requirements are never public automatically.
- Next action: Commit and push, create/deploy the collection worker, redeploy `propai-lab:main`, run one worker cycle, then verify a generated collection and one private requirement bucket.
- Independent verifier verdict: PARTIAL: local implementation, tests, build, and production schema pass; worker deployment, first generated collection, and live UI verification remain pending.

### Deployment follow-up — 2026-09-10

- Requested outcome: Create and run the internal Coolify worker for deterministic public collections.
- Changes/services: Created Coolify application `public-collections-worker` in the production environment from `vishalgojha/propai-lab:main`, using `/Dockerfile.public-collections-worker`, with no public FQDN. Configured production Supabase runtime variables. Fixed the worker’s Supabase pagination compatibility and deduplicated typed item references before insert.
- Verification: Focused tests passed 9/9; Python compilation and scoped diff checks passed. Coolify deployments completed for commits `4c733f81` and `c4aed1da`. The worker is `running:unknown` with no FQDN, and logs show successful writes to the production collection tables. The first full 30-day cycle is still processing the large source view; no post-fix error is present in the latest logs.
- Deployment/push: Worker service is deployed through Coolify. Commits `4c733f81` and `c4aed1da` were pushed to `origin/main`. The public www application still needs a separate redeploy to expose `/collections`.
- Limitations: The initial backfill is still running and public UI verification cannot be completed until `propai-lab:main` is redeployed. Requirement-bucket live verification also remains dependent on approved requirements and matcher execution.
- Next action: Let the initial worker cycle finish, redeploy `propai-lab:main`, then verify one public collection and one private requirement bucket end to end.
- Independent verifier verdict: PARTIAL: the internal service exists, is deployed, and is writing live rows; the first cycle and public www deployment remain pending.

## 2026-09-10 — WhatsApp pairing onboarding refresh

- Requested outcome: Make PropAI WhatsApp onboarding as clear and low-friction as the Perisclaw-style flow while retaining the existing secure WhatsMeow pairing backend.
- Changes: Updated `frontend/src/app/connections/page.tsx` so disconnected phones show a focused “Connect PropAI to WhatsApp” guide with three phone-side steps, a clearer “Get linking code” action, explicit one-time/dynamic-code wording, and tap-to-copy pairing code feedback. Existing live polling, expiry handling, QR support, reset/re-pair, and connected-session persistence were preserved.
- Verification: Impeccable detector returned no findings; scoped `git diff --check` passed; frontend production build passed with Next.js 16.2.9. Repository-local task verifier verdict: PASS for the requested local UI change; production visual verification remains pending.
- Deployment/push: No deployment performed because redeploy was not requested. Relevant Coolify service: `propai-lab:main-app`. Push status is pending this task.
- Limitations: The WhatsApp linking code remains generated by the existing backend and is not a permanent fixed code. Live pairing should be smoke-tested after redeployment.
- Next action: Commit and push the scoped UI/report changes, then redeploy `propai-lab:main-app` and verify the connection screen and one real pairing attempt.
- Independent verifier verdict: PASS for local implementation and build; production redeployment and live pairing verification are explicitly pending.

## 2026-09-10 — Canonical self-chat data-search loop

- Requested outcome: Make WhatsApp self-chat search both the shared PropAI marketplace and the connected workspace's original WhatsApp group messages through the same agent loop.
- Changes: Added the tenant-scoped read-only `search_group_messages` tool over existing `raw_messages`; it returns source text, group, sender, timestamp, and evidence identifiers. Updated self-chat routing and prompts so data-shaped requests use the bounded LangGraph loop, while casual messages may use the lightweight path. Shared listing search remains cross-broker; private clients, CRM records, requirements, and notes remain workspace-scoped. Updated the living architecture contract.
- Files/services: `agent_tools.py`, `routers/self_chat.py`, `routers/common.py`, `architecture.md`, and `tests/test_agent_tools.py`. No database migration was required; no duplicate inventory table was introduced.
- Verification: `pytest -q tests/test_agent_tools.py` passed 8/8; Python compilation passed for the changed agent modules; scoped `git diff --check` passed. The broader three-file regression command started successfully but hung in an existing long-running test path and was stopped after 60 seconds; it is not represented as passing.
- Deployment/push: Application deployment was not performed in this task. Relevant service: `api` (self-chat backend); the existing `propai-lab:main-app` is only relevant if its current client needs redeployment. Push status is pending this task.
- Limitations: Live WhatsApp-to-agent verification remains pending redeployment and a real self-chat request. Raw group search is intentionally limited to the linked workspace's captured messages; normalized marketplace listings remain shared across brokers.
- Next action: Commit and push the scoped changes, redeploy `api`, then test “show 3 BHK in Bandra West” and “what did brokers post about Bandra West?” from self-chat, including one combined question that should call both tools.
- Independent verifier verdict: PASS for the requested local implementation: both search sources are exposed through the bounded graph, tenant/shared boundaries are explicit, and focused tests pass. Live deployment verification remains explicitly pending.

## 2026-09-10 — Self-chat agent persona and semantic routing

- Requested outcome: Keep guardrails without making self-chat keyword-routed; make it feel like a capable broker closing buddy.
- Changes: Removed the casual-versus-search keyword gate from both authenticated and WhatsMeow self-chat paths. Every turn now enters the bounded LangGraph loop, where the agent chooses conversation, search, comparison, lookup, matching, or an approved action. Added a direct, context-aware, commercially useful closing-buddy persona while retaining source-grounding, tenant boundaries, confirmation gates, and concise WhatsApp formatting. Updated architecture documentation.
- Files/services: `routers/self_chat.py`, `routers/common.py`, `architecture.md`, and this report. No schema or migration change.
- Verification: Python compilation and scoped diff checks pass; existing focused agent-tool tests remain 8/8. Independent review confirms no quick-reply branch remains on self-chat request routing.
- Deployment/push: Not deployed yet. Relevant service: `api`.
- Limitations: Live persona and multi-turn behavior need a real WhatsApp smoke test after redeployment; model quality still depends on the configured workspace provider.
- Next action: Commit and push, redeploy `api`, then test a greeting, an ambiguous broker question, a listing search, a group-evidence question, and a request that requires confirmation.
- Independent verifier verdict: PASS for the requested local routing/persona change; live deployment verification remains pending.

## 2026-09-10 — Restore WhatsApp raw-message conflict target

- Requested outcome: Diagnose why a newly connected WhatsApp self-chat received no reply.
- Finding/fix: Production logs showed `raw_messages insert failed` with PostgreSQL `42P10` because the ingestor's partial `ON CONFLICT (tenant_id, message_uid) WHERE source = 'WHATSAPP'` had no inferable matching index. Added and applied tenant-scoped partial unique indexes for `WHATSAPP` and `WABA_INBOUND`, with predicates exactly matching the write paths. This restores raw-message persistence and therefore allows self-chat events to reach the agent.
- Files/services: `supabase/migrations/20260910150000_restore_whatsapp_raw_message_dedupe.sql`; production database. No application code change or ingestor redeploy was required.
- Verification: Live index query confirmed both exact predicates. A rollback-only probe passed conflict-target inference and reached the expected tenant foreign-key check, proving the original `42P10` failure is resolved. Coolify ingestor logs were the diagnostic evidence and showed the prior repeated insert failures.
- Deployment/push: Migration applied directly to production; migration commit/push is pending. Relevant runtime: Supabase database and existing `ingestor` service.
- Limitations: A fresh WhatsApp message still needs to be sent to verify the full persist → API self-chat → agent → reply path. Existing messages lost at the failed insert boundary cannot be reconstructed by this fix.
- Next action: Commit and push the migration, resend `Hey` once, then inspect ingestor/API logs for `self-chat command received`, `/api/internal/self-chat`, and `self-chat reply sent`.
- Independent verifier verdict: PASS for the database failure fix; live end-to-end reply confirmation remains pending the user's retry.

## 2026-09-10 — WhatsApp disconnected-card color cleanup

- Requested outcome: Make the disconnected WhatsApp card visually clean and consistent with the light connections surface.
- Changes: Removed the full-card accent-green treatment from the disconnected phone card. Restored the neutral card/surface palette, kept green for status and pairing affordances, and added restrained styling for the pairing guide steps and recovery panel in `frontend/src/app/connections/page.tsx` and `frontend/src/app/globals.css`.
- Verification: Impeccable detector returned no findings; scoped `git diff --check` passed; frontend production build passed with Next.js 16.2.9. Independent task verifier verdict: PASS for the requested local UI outcome, with evidence at `frontend/src/app/connections/page.tsx:666-683` and `frontend/src/app/globals.css:79-108`.
- Deployment/push: No deployment performed. Relevant Coolify service: `propai-lab:main-app`. Push status is pending this task.
- Limitations: This turn verified the local build and styling source; no live browser screenshot or post-deployment visual check was performed.
- Next action: Commit and push the scoped UI/report changes, then redeploy `propai-lab:main-app` if desired and visually verify `/whatsapp?tab=numbers`.
- Independent verifier verdict: PASS for the requested local implementation and build; production redeployment and live visual verification remain explicitly pending.

## 2026-09-10 — WhatsApp pairing-control contrast follow-up

- Requested outcome: Make the remaining disconnected-card controls visible in the live light theme.
- Changes: Added scoped disabled-state styling for `Get linking code` and `Reset & re-pair`, preserving readable neutral and warning colors while status checks are in progress. Updated `frontend/src/app/connections/page.tsx` and `frontend/src/app/globals.css`.
- Verification: Impeccable detector returned no findings; scoped `git diff --check` passed; the first sandboxed build was blocked by Turbopack process permissions, then the elevated frontend production build passed with Next.js 16.2.9. Independent task verifier verdict: PASS for the requested local UI outcome.
- Deployment/push: No deployment performed yet. Relevant Coolify service: `propai-lab:main-app`. Push status is pending this follow-up.
- Limitations: No live browser or post-deployment screenshot was performed in this turn.
- Next action: Commit and push the scoped follow-up, then redeploy `propai-lab:main-app` and verify the disabled controls visually.
- Independent verifier verdict: PASS for local implementation and elevated production build; live visual verification remains pending.

## 2026-09-10 — Remove amber text from light WhatsApp card

- Requested outcome: Do not use yellow/amber text on light WhatsApp card backgrounds.
- Changes: Scoped the light connections card so amber text utilities resolve to the dark foreground color. This removes yellow from `Reset & re-pair`, the recovery guide, and other warning labels inside the card without changing dark modal warning treatments.
- Verification: Impeccable detector returned no findings; repository-root scoped `git diff --check` passed; frontend production build passed with Next.js 16.2.9. Independent task verifier verdict: PASS for the requested local UI outcome.
- Deployment/push: No deployment performed yet. Relevant Coolify service: `propai-lab:main-app`. Push status is pending this follow-up.
- Limitations: No live browser screenshot or post-deployment visual check was performed in this turn.
- Next action: Commit and push the scoped contrast fix, then redeploy `propai-lab:main-app` and verify the connected and disconnected WhatsApp cards.
- Independent verifier verdict: PASS for local implementation and build; live visual verification remains pending.

## 2026-09-10 — Item-scoped extraction authority hardening

- Requested outcome: Stop Sarvam extraction quality regressions where a multi-listing broadcast leaks a sibling listing's quote or inferred facts into the current row.
- Finding/fix: The Evershine Jewel example had the correct ₹4.50L item slice, but authority provenance referenced a separate ₹2.90L block. Extraction and typed persistence now carry a stable `raw_message_id:listing_index` slice identity, re-evaluate authority against the exact item slice, preserve evidence line breaks, and clear/review unsupported inferred `possession_status` and `price_basis` values.
- Files/services: `extraction.py`, `storage/supabase.py`, `tests/test_source_authority_candidates.py`, and `architecture.md`. No database migration required.
- Verification: Focused boundary/provenance/gating tests passed 4/4; Python compilation and scoped diff checks passed. The broader authority/grounding set passed 41 tests with 3 pre-existing dirty-worktree failures. Full extraction pipeline collection is currently blocked because this checkout lacks the local `langgraph` dependency.
- Deployment/push: Not deployed yet; relevant Coolify services are `extraction-worker` and `api` because both extraction and typed persistence paths changed. Push follows after this report is staged.
- Limitations: Existing bad rows are not rewritten automatically; they require a bounded replay/backfill after deployment. Production smoke verification is pending.
- Next action: Push the scoped commit, redeploy `extraction-worker` and `api`, then reprocess one known multi-listing sample and verify its `source_authority.source_slice` and price decision match the selected slice exactly.
- Independent verifier verdict: PARTIAL — the permanent code/test boundary fix is present and focused tests pass, but full local test collection and production verification remain pending.

## 2026-09-10 — Remove duplicate storage authority pass

- Requested outcome: Stop repeated extraction instructions and conflicting downstream rewrites from producing inconsistent fields.
- Changes: Removed the second `evaluate_extraction_authority` pass from typed Supabase persistence. Extraction now owns the semantic authority decision and storage preserves that item-scoped result; legacy direct writes remain reviewable instead of being silently reinterpreted.
- Verification: Python compilation passed; 17 focused source-authority tests passed; scoped diff checks passed.
- Deployment/push: Push pending. Relevant services: `extraction-worker` and `api`.
- Limitations: Existing rows still require bounded replay; full pipeline collection remains blocked locally by the missing `langgraph` dependency, and production smoke verification is pending.
- Next action: Redeploy both services, reprocess the Santacruz sample, and confirm storage preserves the extraction-stage `source_authority` unchanged.
- Independent verifier verdict: PASS for the scoped single-owner code path; production deployment and end-to-end verification remain pending.

## 2026-09-10 — Compact dense workspace data pages

- Requested outcome: Reduce wasted desktop padding and centered whitespace across admin and data-heavy authenticated pages so operators can see more live data at once.
- Changes: Added a shared route-density signal in `frontend/src/app/layout.tsx` and scoped desktop CSS in `frontend/src/app/globals.css` that removes the second max-width gutter from dense workspace pages, including nested pipeline-health panels. Mobile route spacing is unchanged.
- Verification: Impeccable detector returned no findings; scoped `git diff --check` passed; elevated frontend production build passed with Next.js 16.2.9 and all 75 static routes generated successfully. Live browser verification was unavailable in this session.
- Deployment/push: Changes pushed to `origin/main` in commit `729c85e2`; no deployment performed. Relevant Coolify service: `propai-lab:main-app`.
- Limitations: The change centralizes outer canvas density; individual page-internal card padding and intentional reading-width sections remain unchanged. A post-deployment screenshot should confirm the target admin pages at desktop and mobile widths.
- Next action: Redeploy `propai-lab:main-app` and visually verify `/extractions`, `/admin`, and `/admin/pipeline-health`.
- Independent verifier verdict: PASS for the local implementation and build; live visual verification and redeployment remain pending.

## 2026-09-10 — Route WhatsApp self-chat through OpenClaw

- Requested outcome: Keep owner self-chat out of the raw-message extraction backlog and route it through the less deterministic OpenClaw agent path.
- Changes: WhatsMeow now dispatches detected owner self-chat asynchronously and returns before `insertRawMessage`; the API stores the conversation only in tenant-scoped chat tables and both self-chat endpoints use the private OpenClaw gateway with bounded PropAI tools. Added an OpenClaw self-chat model/kill switch, deployment documentation, and architecture invariant.
- Files/services: `services/whatsmeow-ingestor/main.go`, `routers/self_chat.py`, `architecture.md`, `deploy/openclaw/README.md`, and `tests/test_self_chat_format.py`. No database migration was required.
- Verification: Independent task-verifier second pass returned PASS. `pytest -q tests/test_self_chat_format.py` passed 15/15; `GOCACHE=/tmp/propai-go-cache go test ./...` passed; Python compilation and scoped `git diff --check` passed.
- Deployment/push: Not deployed yet. Relevant Coolify services are `ingestor`, `api`, and `propai-lab:openclaw`; push follows after this report is staged. No redeploy was performed because it was not requested.
- Limitations: Live OpenClaw connectivity and an end-to-end WhatsApp smoke test remain pending deployment. The API requires `OPENCLAW_API_URL` and `OPENCLAW_API_KEY`; `OPENCLAW_SELF_CHAT_ENABLED` can disable the route.
- Next action: Commit and push the scoped changes, configure the self-chat variables on `api`, redeploy `api`, `ingestor`, and `propai-lab:openclaw`, then send one self-chat message and confirm it appears only in the chat transcript and receives a reply.
- Independent verifier verdict: PASS for the local implementation; live deployment and end-to-end WhatsApp verification remain pending.

## 2026-09-10 — Create OpenClaw Coolify resource

- Requested outcome: Create the missing private OpenClaw Coolify resource for self-chat.
- Changes: Created `propai-lab:openclaw` in PropAI Labs → production on the `propai` server, configured port `18789`, no public domain, internal alias `openclaw`, and the required runtime variables. Deployed and confirmed healthy.
- Files/services: Coolify application `vepdfbrwm2pui4rsr0o2wwaj`; no repository files changed.
- Verification: Final deployment `f5az4enn3p53oryxmp6nhhcx` finished; Coolify reports `running:healthy`, `ports_exposes=18789`, `domains=null`, and `custom_network_aliases=openclaw`.
- Deployment/push: OpenClaw deployed in Coolify. Relevant API/ingestor redeploys were not performed in this turn.
- Limitations: The Coolify application uses an inline self-contained Dockerfile because its public application build context did not include the repository tree; future OpenClaw Dockerfile/config changes require updating this resource or migrating it to a checked-in compose/source deployment.
- Next action: Redeploy `api` and `ingestor` from commit `56e5f700`, then send one WhatsApp self-chat message to verify the end-to-end reply path. Review and rotate credentials if the earlier failed Coolify deployment logs remain accessible.
- Independent verifier verdict: PASS for resource creation and health; end-to-end self-chat verification remains pending.

## 2026-09-10 — Redeploy self-chat API and WhatsApp ingestor

- Requested outcome: Activate the OpenClaw self-chat path in production.
- Changes: Triggered Coolify redeployments for `api` and `Ingestor`; OpenClaw was left unchanged because it was already healthy.
- Files/services: Coolify deployments `g8vya0y0j4132uvbpr4n0psg` (`api`) and `pzx3ktildx6c3efr8pov00tc` (`Ingestor`).
- Verification: Both deployment requests were accepted; `Ingestor` reports `running:healthy`; `api` responds to `/health` with HTTP 200 and `{"status":"ok"}`. Coolify labels the API `running:unknown`, so a WhatsApp smoke test is still the final confirmation.
- Deployment/push: Production redeployments completed; this report update is pending commit and push.
- Limitations: No test message was sent from WhatsApp in this turn. Existing unrelated API logs show Supabase extraction-progress statement timeouts.
- Next action: Send a fresh self-chat message and confirm an OpenClaw-style response that does not enter `raw_messages`.
- Independent verifier verdict: PASS for deployment acceptance and service health; end-to-end WhatsApp behavior remains pending smoke test.

## 2026-09-11 — Harden frontend sign-in error handling

- Requested outcome: Diagnose the sign-in modal's `JSON.parse: unexpected character` error shown after a failed login attempt.
- Changes: Wrapped password sign-in errors in `frontend/src/lib/auth.ts` and translated malformed JSON responses and network failures into actionable user-facing messages instead of leaking the parser exception.
- Files/services: `frontend/src/lib/auth.ts`; frontend deployment is still pending.
- Verification: Scoped `git diff --check` passed; `NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder npm run build` passed with all 75 routes generated.
- Deployment/push: Pending frontend deployment and push of this report.
- Limitations: The screenshot's backend/auth response is not yet reproduced end-to-end, so this hardens the error boundary but does not prove the underlying sign-in service is accepting credentials.
- Next action: Redeploy `propai-lab:main-app`, retry sign-in, and inspect the browser network response if the service still returns non-JSON.
- Independent verifier verdict: PARTIAL — the parser leak is handled and the build passes, but production sign-in remains unverified.

## 2026-09-11 — Broaden sign-in network error classification

- Requested outcome: Handle the same sign-in failure when it is reproduced in Firefox private browsing and Supabase wraps it as a generic error.
- Changes: `frontend/src/lib/auth.ts` now recognizes wrapped JSON parser, `NetworkError`, `Failed to fetch`, and related browser fetch messages rather than relying only on native error classes.
- Files/services: `frontend/src/lib/auth.ts`; frontend deployment remains pending.
- Verification: Scoped diff inspection passed. The same frontend build passed after the initial auth hardening; a subsequent rebuild was blocked by a lingering Next.js/Turbopack build lock/stream error after compilation began.
- Deployment/push: Pending frontend deployment and push of this report.
- Limitations: Incognito reproduction confirms this is not a stale browser session or extension, but the browser-to-Supabase request still needs network-panel evidence to identify the exact transport cause.
- Next action: Redeploy `propai-lab:main-app`, retry once, and inspect the Supabase Auth request status/blocked reason if the message remains.
- Independent verifier verdict: PARTIAL — error handling covers the observed wrapped failures, but the underlying auth transport and production login remain unverified.

## 2026-09-11 — Recover Supabase unhealthy services

- Requested outcome: Recover the production Supabase project after Database, PostgREST, Auth, and Storage reported unhealthy.
- Changes: Restarted Supabase project `jsoiuzfwohtfkctlkozw` through the Management API; no schema or application data changes were made.
- Files/services: Supabase production project only; restart request returned HTTP 200.
- Verification: Management health checks now report `db`, `rest`, `auth`, and `storage` as `healthy: true` / `ACTIVE_HEALTHY`. Direct Auth and REST probes respond, and Storage status returns HTTP 200.
- Deployment/push: Supabase recovery completed; this report update is pending commit and push. Database size remains `t3a.small`.
- Limitations: Restart is a temporary recovery measure; prior logs showed repeated 522s and worker pressure, so overload may recur.
- Next action: Retry PropAI login and self-chat. If 522s return, pause or throttle workers and scale the database before restarting again.
- Independent verifier verdict: PASS for the authorized restart and service-health recovery; application login/self-chat smoke tests remain pending.

## 2026-09-10 — Increase extraction replay capacity

- Requested outcome: Let the extraction worker drain the explicitly approved 228-message production replay corpus without starving the live lane.
- Changes/services: Updated production `extraction-worker` env to `EXTRACTION_WORKER_CONCURRENCY=12`, `EXTRACTION_WORKER_FAST_LANE_SLOTS=4`, and `EXTRACTION_WORKER_BACKLOG_LANE_SLOTS=8`; batch size was unchanged. Redeployed Coolify application `fpmr99xoi9qc7bdclals8jzb`.
- Verification: Coolify deployment `ibzvcc5xj5vjk5g9njuqq3a7` finished successfully from commit `ce339a028fb653155b3cd39f77eb9ef293567e8a`. Read-only production verification found all 228 replayed raw messages terminal: 26 succeeded, 68 skipped, 84 retry-window-expired, 47 system-blocked, and 3 under-min-chars; 0 pending and 0 running.
- Deployment/push: Runtime configuration and redeployment completed in Coolify. This report-only follow-up requires a scoped commit and push; no application code changed.
- Limitations: The terminal outcome counts reflect existing retry-window and system-block rules; increasing concurrency does not convert those outcomes into successful extraction. No live-lane starvation was observed during verification.
- Next action: Restore replay capacity to normal values after any further approved replay, or retain the lane split if sustained backlog volume justifies it.
- Independent verifier verdict: PASS — deployment completed and the exact approved replay set reached terminal state, verified by an independent read-only database query.

## 2026-09-11 — Fix extraction activity search races

- Requested outcome: Make the Extraction Activity search return the rows for the query currently visible in the search field.
- Changes: Added a 250 ms search debounce, separate input/query state, an accessible search label and clear button, and a request-sequence guard so late responses from older queries cannot overwrite the latest results in `frontend/src/app/extractions/page.tsx`.
- Verification: Frontend production build passed with Next.js 16.2.9 and all 75 routes generated. Scoped `git diff --check` passed. The Impeccable detector reported only pre-existing contrast warnings in the page's existing colored metric cards; none were introduced by the search change.
- Deployment/push: Not deployed yet. Relevant Coolify service: `propai-lab:main-app`. Search fix was pushed in commit `b0f2b304`. The commit also contained three pre-existing staged files (`extraction.py`, `source_boundary.py`, and `tests/test_extraction_pipeline.py`); they were not part of this search fix and were not edited in this turn.
- Limitations: Live browser verification was not available in this turn; the fix addresses the observed stale-response failure mode and preserves the existing backend search fields.
- Next action: Push the scoped commit, redeploy `propai-lab:main-app`, and verify a query such as `avlesh` returns only matching extraction rows.
- Independent verifier verdict: PASS for the local implementation and build; production deployment and live search verification remain pending.

## 2026-09-11 — Repair mixed-broadcast requirement extraction

- Requested outcome: Stop the Lavelsh Court supply listing from becoming a false ₹30 Cr requirement, preserve its ₹2.5 lakh rent, and correctly represent the separate Juhu/JVPD buyer demand.
- Changes: Explicit `OUTRIGHT REQUIREMENT` headings now receive exclusive source slices; requirement items cannot inherit sibling listing buildings; explicit outright demands are routed as purchase requirements; replay writes clear stale requirement routes and nullable building identity fields.
- Files/services: `extraction.py`, `source_boundary.py`, `storage/supabase.py`, and regression coverage in `tests/test_extraction_pipeline.py`. Coolify `extraction-worker` (`fpmr99xoi9qc7bdclals8jzb`) redeployed from commit `9addccb8` (deployment `pplhopff2xea7m6rnh5z63j7`).
- Verification: Python compilation and pure source regression passed. Full pytest collection remains blocked by the pre-existing missing `langgraph` module. Production replay of raw IDs `1055152` and `1056721` finished successfully. Both now have only `residential_sale_requirements` rows with `transaction_type=sale`, no building name, Juhu locality, BHK 4, and budget ₹30–45 Cr; no rent-requirement rows remain. Separate commercial rent rows remain Lavelsh Court, Bandra West, ₹250,000/month, source text `₹2.50 Lakhs`.
- Deployment/push: Commits `9addccb8` and `c59776e2` pushed to `origin/main`; extraction worker deployment completed successfully. No frontend redeploy was required because the user-visible data is served from the corrected typed projections.
- Limitations: The source says `4BHK / 5BHK`; the existing typed contract currently retains the first normalized BHK value (`4`) rather than an options array containing both values. The raw source evidence remains attached for review.
- Next action: Refresh Market Inbox and confirm the old Lavelsh requirement card is gone; use the extraction activity/source evidence panel for any future mixed broadcasts.
- Independent verifier verdict: PASS — local routing/persistence checks and live production replay/projection queries all satisfy the requested correction.

## 2026-09-11 — Restore extraction worker normal capacity

- Requested outcome: Remove the temporary replay capacity increase after the approved corpus was fully drained.
- Changes/services: Restored production `extraction-worker` env to `EXTRACTION_WORKER_CONCURRENCY=4`, `EXTRACTION_WORKER_FAST_LANE_SLOTS=2`, and `EXTRACTION_WORKER_BACKLOG_LANE_SLOTS=2`. Batch size was unchanged.
- Verification: Coolify deployment `iy2yooqd6kwut65a0w2gdnw9` finished successfully in 240 seconds. Coolify confirmed each production variable update with the restored value before redeploy.
- Deployment/push: Runtime configuration restored and redeployed on Coolify. No application code changed; this report update requires a scoped commit and push.
- Limitations: No new replay was started; this change only returns normal live-processing capacity.
- Next action: Monitor the extraction progress page and worker heartbeat for normal live-lane health.
- Independent verifier verdict: PASS — restored production values and successful deployment were independently confirmed through Coolify.

## 2026-09-11 — Fix market-feed repost deduplication with optional field drift

- Requested outcome: Stop the Market Inbox from showing the same Lavelsh Court office repost as multiple cards.
- Finding/fix: Two production rows had the same broker, building, rent, exact source slice, and listing index; one parse had no area while the other had `1,050 sqft`. The feed fingerprint treated the missing/recovered area as different identity. The shared read-time merge now recognizes exact broker/source-slice/index reposts, rejects populated field conflicts, and preserves the richer optional fields. Different floors, units, or source slices remain separate.
- Files/services: `storage/supabase.py` and `tests/test_canonical_opportunity_identity.py`. No production data migration required; the correction is applied in the feed projection.
- Verification: `pytest -q tests/test_canonical_opportunity_identity.py tests/test_data_quality_guards.py` passed 23/23. Scoped `git diff --check` passed.
- Deployment/push: Not deployed yet. Relevant Coolify services: `api` for the feed projection and `propai-lab:main-app` for the dashboard. Push follows after the scoped commit.
- Limitations: Existing typed rows remain unchanged by design; the duplicate cards disappear after the API/dashboard deployment and refresh.
- Next action: Push, redeploy `api` and `propai-lab:main-app`, then refresh Market Inbox and confirm only one Lavelsh Court 2.5L card remains while distinct inventory stays visible.
- Independent verifier verdict: PASS for the deterministic merge rule and focused regression tests; live deployment verification remains pending.

## 2026-09-11 — Reduce API Docker build memory peak

- Requested outcome: Recover the failed Coolify deployment of the API after the Docker build was killed during the Chromium/Node dependency layer.
- Finding/fix: `Dockerfile.api` was installing Debian `nodejs` and `npm` in the same apt transaction as Chromium. Node/npm now build in a `node:22-bookworm-slim` stage, install `agent-browser` there, and copy the resulting `/usr/local` runtime into the Python image. The API still retains `/usr/bin/chromium` and the agent-browser runtime; only the redundant Debian Node/npm apt graph was removed.
- Files/services: `Dockerfile.api`; intended service is Coolify `api` (the `propai-lab:main-app` redeploy remains after API verification).
- Verification: Scoped Dockerfile assertions and `git diff --check` passed. Local Docker daemon access was unavailable (`permission denied` on `/var/run/docker.sock`), so the real image build remains to be verified by Coolify.
- Deployment/push: Committed as `2bcac7d9` and pushed to `origin/main`. Coolify `api` deployment `gdzvzjr77wy20nv5hwklkyi1` finished successfully from that commit in 234 seconds. The public dashboard was not redeployed because this was an API image/build recovery; `propai-lab:main-app` remains pending only if its own source changed.
- Limitations: The supplied log ends during apt package installation without the underlying signal; the successful Coolify build confirms the resource-peak fix through image assembly, but does not by itself prove every browser action workflow.
- Next action: Refresh Market Inbox and verify the Lavelsh Court repost collapse. If browser actions are exercised, confirm the workspace browser smoke path separately.
- Independent verifier verdict: PASS — the scoped Dockerfile change passed static checks, Coolify built and deployed the exact pushed commit, and the live API health endpoint returned HTTP 200.
