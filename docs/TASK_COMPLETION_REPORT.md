
## 2026-10-29 — Target-market locality gate and candidate miner

- Requested outcome: Create a practical way to identify the owner's six target
  localities from noisy WhatsApp broker wording and prepare deterministic
  extraction rules.
- Files changed: `registry/target_markets.py`,
  `tools/mine_target_location_candidates.py`, `tests/test_target_markets.py`,
  and `docs/TARGET_MARKET_LOCATION_WORKFLOW.md`.
- Services changed: None. No production extraction path, database schema, or
  live data was changed.
- Verification performed: Read-only Coolify/Supabase access was validated.
  The full production corpus was scanned successfully in a validated run:
  79,528 `raw_messages` rows were processed, then the output was filtered to
  121 exact/review signal and road candidates in `target-location-review.csv`.
  A later refresh attempt hit transient Supabase DNS failure before replacing
  that successful result. `pytest -q
  tests/test_target_markets.py` — 4 passed;
  `python3 -m py_compile registry/target_markets.py
  tools/mine_target_location_candidates.py` — passed; CLI help invocation —
  passed. Independent second-pass verdict: PARTIAL. The implemented gate and
  review miner are present and tested, but a real raw-message export was not
  available, so the corpus-derived candidate list has not been generated or
  owner-reviewed.
- Deployment/push status: Not deployed. Push could not be attempted because
  the repository Git metadata is corrupt: `.git/objects/85/` contains an empty
  object and `HEAD` cannot be read (`fatal: bad object HEAD`).
- Known limitations/failures: The candidate miner does not infer geography or
  update the registry automatically. Numeric roads remain review-only unless
  the message supplies side/locality context. `16th Road`, `17th Road`, `Khar
  Gymkhana`, and bare locality names remain review-only unless stronger context
  is present. The Supabase DNS failure should be retried before treating the
  corpus count as a stable live snapshot.
- Next action: Provide/export a raw-message corpus, run the miner, review the
  resulting CSV, then promote confirmed roads/landmarks into approved signals
  and wire the gate into the extraction worker behind an explicit feature flag.
## 2026-10-30 — Broad WhatsApp capture visibility and DM archive

- Requested outcome: As this is a single-owner workspace, process the primary
  WhatsApp connection's groups and DMs without group selection blocking, keep
  DMs separate in the workspace inbox, and retain deterministic
  keyword-gated extraction.
- Files changed: `storage/supabase.py`, `routers/workspace.py`,
  `frontend/src/lib/api.ts`, `frontend/src/app/inbox/page.tsx`,
  `architecture.md`, and `docs/DECISIONS.md`.
- Services changed: None deployed. The existing Coolify `ingestor` was
  previously restarted and was observed healthy, but this code change has not
  been deployed.
- Verification performed: Python compilation passed; focused worker and inbox
  tests passed (`19 passed`); direct groups-vs-DM query-routing assertion
  passed; `git diff --check`
  could not complete because the repository contains empty/corrupt Git object
  files. The frontend typecheck ran but reports many existing application-wide
  TypeScript errors; no new error was isolated to the DM-scope API calls. A
  direct groups-vs-DM query-routing assertion passed. The focused extraction
  lane suite has one pre-existing consent-fixture failure. The independent
  task-verifier verdict is **PARTIAL**: the local path is wired, but production
  behavior and a clean full typecheck are not verified.
- Deployment/push status: Not pushed or deployed. `HEAD` is unreadable
  (`fatal: bad object HEAD`) and Git reports empty objects under `.git/objects/`.
- Known limitations or failures: Secondary connected numbers remain raw-only.
  Primary-connection DMs still do not bypass locality or the existing
  property-keyword gate to become typed market inventory.
  Historical sync remains governed by the existing deployment setting and was
  not changed by this UI/API work.
- Next action: Repair or provide a healthy Git checkout, run the full relevant
  test suite, deploy `propai-lab:main-app` plus the API service, then verify the
  Groups and Direct messages tabs against a live connected WhatsApp session.
## 2026-10-30 — Repair corrupted Git checkout

- Requested outcome: Restore a usable Git repository without losing the
  current PropAI source tree or local changes.
- Files/services changed: No application or production service changes. A
  source-only backup was created at `/tmp/propai-lab-backup-clean-l1q2Cr`; a
  clean clone now occupies `/home/vishal/propai-lab`; the damaged original was
  preserved at `/home/vishal/propai-lab-damaged-20261030-170251`.
- Verification performed: Clean clone completed from `origin`; `git fsck
  --full --no-reflogs` passed with no errors; `HEAD` resolves to
  `85468bb2c79a95c40f3a7000d935ccaa663b8590`; origin fetch/push URLs are
  present; the preserved source changes remain visible in `git status`.
- Deployment/push status: No commit, staging, push, or deployment performed.
  Existing and task-local changes were intentionally left unstaged for review.
- Known limitations or failures: The workspace contains 49 tracked/untracked
  changes inherited from the prior checkout, including unrelated pre-existing
  work. They must be reviewed before selecting hunks for a task commit.
- Next action: Review and stage only the intended WhatsApp/private-brokerage
  changes, then run verification and push a focused commit.
- Independent task-verifier verdict: **PASS** for repository repair; application
  changes remain uncommitted and were not part of this repair verification.

## 2026-10-30 — Tighten private WhatsApp self-chat search

- Requested outcome: Make the WhatsApp agent tighter and more useful for the
  owner's brokerage by avoiding broad nearby/group results in exact property
  searches.
- Files changed: `routers/self_chat.py`, `routers/ai_chat.py`,
  `tests/test_self_chat_format.py`, plus the previously staged WhatsApp
  ingestion/DM archive and single-owner extraction files.
- Services requiring redeployment: `api`, `extraction-worker`, and
  `propai-lab:main-app`. No production redeployment was performed.
- Verification performed: New regression tests for ordinary exact searches
  and explicit group-evidence searches passed; focused extraction-worker and
  inbox route tests passed; Python compilation passed; staged diff check passed.
  The full self-chat test file still has one unrelated pre-existing timezone
  fixture failure.
- Deployment/push status: Commit `134809de` was pushed successfully to
  `origin/main`. Existing unrelated work remains unstaged.
- Known limitations or failures: Live WhatsApp behavior is not verified until
  the three services are redeployed. The agent still needs a live test for the
  exact query shown in the screenshot and a follow-up such as “show group
  messages for this.”
- Next action: Redeploy the API, extraction worker, and dashboard, then test
  the exact Bandra West/Khar West query and the explicit group-evidence path.
- Independent task-verifier verdict: **PARTIAL** — local behavior and focused
  tests pass, but production deployment and live WhatsApp acceptance remain.

## 2026-10-30 — Redeploy private WhatsApp brokerage fix

- Requested outcome: Redeploy the tightened self-chat search behavior.
- Files/services changed: Coolify deployments for `api`, `extraction-worker`,
  and `propai-lab:main-app`; pushed syntax repair commit `fb248912` after the
  first API and worker builds exposed an invalid `storage/supabase.py` class
  boundary.
- Verification performed: API deployment `nvo905m7tw7eyzael67wyfs9` finished;
  extraction-worker deployment `djpom8f56d8uocwcowtf6j3s` finished; dashboard
  deployment `de20plaqgdggmx0isiuoo1ij` finished; Coolify reports all three
  resources running, and the ingestor remains running/healthy.
- Deployment/push status: `fb248912` pushed to `origin/main`; production
  deployments completed successfully.
- Known limitations or failures: Coolify reports the API, worker, and
  dashboard health state as `running:unknown` rather than `running:healthy`;
  the exact WhatsApp query still needs a live acceptance test.
- Next action: Test the exact Bandra West/Khar West query in WhatsApp and then
  test an explicit group-evidence request.
- Independent task-verifier verdict: **PASS** for deployment completion;
  live WhatsApp acceptance remains pending.

## 2026-10-30 — Full raw WhatsApp deletion after 30 days

- Requested outcome: Delete all `raw_messages` rows older than 30 days to stop
  Supabase storage growth, including linked records where foreign-key behavior
  removes them.
- Files/services changed: Added
  `supabase/migrations/20261030180000_full_raw_message_retention.sql` and
  updated `docs/DATA_QUALITY.md` and `docs/ARCHITECTURE.md`.
- Verification performed: Reviewed repository foreign-key definitions; the
  migration deletes in bounded batches, detaches nullable references, removes
  non-nullable dependents, and lets existing cascades remove source-linked
  typed rows. Supabase CLI version is 2.112.0. Local lint could not run because
  the local Postgres instance is not running; linked dry-run could not run
  because no Supabase CLI access token is configured.
- Deployment/push status: Migration is prepared locally but not applied to
  production and not yet pushed; production application deployment is not
  required for the SQL-only change.
- Known limitations or failures: Applying the migration immediately purges
  existing raw rows older than 30 days and may remove linked extracted records,
  as explicitly approved. Full SQL execution verification remains pending
  until Supabase credentials are available.
- Next action: Run `supabase db push --linked` with the project access token,
  then verify the cron job and a dry-run/count before allowing the scheduled
  purge to continue.
- Independent task-verifier verdict: **PARTIAL** — migration reviewed and
  statically checked, but production application is blocked by missing
  Supabase authentication.

### Deployment update

- The supplied Supabase project token was used to execute only this migration
  directly because remote migration history contains many versions missing
  from the checkout. Migration `20261030180000` was then recorded as applied.
- Verification passed: `raw_messages` older than 30 days = `0`; cron job
  `propai-raw-messages-retention` exists with schedule `30 0 * * *` and calls
  `prune_raw_messages(interval '30 days', 2000)`.
- The fetched remote migration files were removed from the worktree after
  verification; no unrelated migration-history repair was performed.
- Updated independent verdict: **PASS** for production application and
  verification. Supabase storage reclamation may still wait for autovacuum.

## 2026-11-03 — Parse live WhatsApp DMs without backfill

- Requested outcome: Parse new incoming WhatsApp direct messages through the
  source-grounded extraction queue, without replaying historical DMs.
- Files/services changed: `extraction_worker.py`, `storage/supabase.py`,
  `supabase/migrations/20261103120000_enable_live_dm_extraction.sql`,
  `architecture.md`, and the extraction policy regression test.
- Verification performed: Python compilation passed; 25 focused extraction,
  policy, and progress tests passed. A broader extraction test set could not
  collect because the environment lacks the optional `langgraph` package.
  Independent second-pass review verdict: **PASS** for the requested local
  code path; historical rows remain processed/suppressed and outgoing rows
  are quarantined before extraction.
- Deployment/push status: Not yet committed, pushed, or deployed. The API,
  extraction-worker, and dashboard services require redeployment after push;
  no production data was backfilled.
- Known limitations or failures: Live production behavior and SQL execution
  against the linked Supabase project are not verified in this session.
- Next action: Stage only this task's hunks, commit and push, then redeploy
  `api`, `extraction-worker`, and `propai-lab:main-app` when authorized.

### Deployment update

- `extraction-worker` deployment `n4w27giwurx729auqh9bfdpj` finished;
  `api` deployment `g5qafafdqv4d6sxagaqpsv9u` finished; and
  `propai-lab:main-app` deployment `h26hb6ncv22965ao3cspwz8j` finished.
- All three deployed commit `ecca60aa`; no historical DM backfill was run.
- Coolify reports the resources as running with health state `unknown`, so a
  live WhatsApp DM acceptance test remains the next validation step.

## 2026-11-04 — Add private all-chat WhatsApp archive search

- Requested outcome: Let the authenticated WhatsApp self-chat agent search the
  owner's captured WhatsApp groups and direct chats for source messages.
- Files/services changed: `agent_tools.py`, `ai_chat_engine.py`,
  `routers/self_chat.py`, `architecture.md`, `docs/DECISIONS.md`, and
  `tests/test_agent_tools.py`. No database migration was required.
- Verification performed: Python compilation passed; 17 focused agent/private
  chat tests passed. The new tool is tenant-scoped, supports all/group/direct
  chat modes, sender/chat filters, date windows, result limits, source metadata,
  and explicit captured-archive coverage disclosure. Independent second-pass
  review checked the tool registry, self-chat prompt, execution path, tests,
  and architecture update.
- Deployment/push status: Not committed, pushed, or deployed in this session.
  The API service requires redeployment before WhatsApp can use the new tool.
- Known limitations or failures: This pass searches captured `raw_messages`
  evidence and does not yet invoke WhatsMeow on-demand history backfill. The
  existing 30-day raw retention contract still limits older searchable data.
  Production and live WhatsApp acceptance are unverified.
- Next action: Add the authenticated self-chat-triggered WhatsMeow history
  backfill flow, then stage only this task's hunks, commit, push, redeploy the
  API, and run a live self-chat search acceptance test.
- Independent task-verifier verdict: **PARTIAL** — the private all-chat search
  path is implemented and locally verified, but direct WhatsApp backfill,
  deployment, and live acceptance remain outstanding.

## 2026-11-04 — Deploy private WhatsApp group and DM archive search

- Requested outcome: Search current WhatsApp group and private DM messages from
  the self-chat agent, using the captured Supabase raw-message archive, without
  history backfill.
- Files/services changed: `agent_tools.py`, `ai_chat_engine.py`,
  `routers/self_chat.py`, `architecture.md`, `docs/DECISIONS.md`, and
  `tests/test_agent_tools.py`. API deployment is required. No schema change.
- Verification performed: 17 focused tests passed; Python compilation passed;
  scoped diff whitespace check passed. Independent second-pass review: PASS for
  local implementation, tool registry, tenant-scoped raw query, group/DM
  filtering, source metadata, and no-backfill behavior.
- Deployment/push status: Pending commit, push, and API redeployment.
- Known limitations or failures: Searches only messages PropAI has captured
  and retained in `raw_messages` (30 days). It does not query the phone's
  internal full-text index or retrieve missing history.
- Next action: Commit and push the scoped changes, redeploy Coolify `api`, and
  run a live WhatsApp self-chat search for a known group or DM message.
- Independent task-verifier verdict: **PASS** for local code; production
  deployment and live acceptance pending.

## 2026-11-04 — Bound WhatsApp self-chat agent latency

- Requested outcome: Diagnose and reduce long waits before self-chat replies.
- Files/services changed: `routers/self_chat.py`; the `api` Coolify service
  needs deployment.
- Verification performed: 27 focused self-chat/workspace-graph tests passed;
  1 unrelated existing prompt-timezone test failed in `build_system_prompt`
  because its fixture passes a string where the function expects a dataframe
  source. Two tests were skipped. Independent review checked the 45-second
  ingestor request deadline against the self-chat graph round limit.
- Deployment/push status: Commit `5e74a520` was pushed to `origin/main` and
  deployed to Coolify `api` (`djbbkdp28uhoc5p8cfnjr642`). Deployment
  `f9ju2wdexcqrs9lyizsa7svz` finished on commit
  `5e74a520b35e61f2771f8aec7809a934cd766696`.
- Known limitations or failures: Production request-specific logs were not
  available in the recent Coolify log windows, so the exact slow turn's timing
  could not be established. Four rounds still allow several sequential model
  calls; it bounds runaway loops but cannot speed a slow provider response.
- Next action: Send a known archive search in WhatsApp and check its
  self-chat timing log to confirm the perceived latency improved.
- Independent task-verifier verdict: **PARTIAL** — the agent's sequential
  call ceiling is reduced from 16 to 4, but live latency remains unverified.

## 2026-11-04 — Keep WhatsApp self-chat prose conversational

- Requested outcome: Stop formatting every WhatsApp self-chat reply as bullets.
- Files/services changed: `routers/self_chat.py` and
  `tests/test_self_chat_format.py`; Coolify `api` requires deployment.
- Verification performed: 10 targeted formatter and NDJSON tests passed,
  including a non-casual ordinary conversation remaining prose. Independent
  review checked both the streaming and non-streaming formatter call sites.
- Deployment/push status: Commit `d4d59124` was pushed to `origin/main` and
  deployed to Coolify `api` (`djbbkdp28uhoc5p8cfnjr642`). Deployment
  `olj5sek9ab1luydz32ju71gx` finished on commit
  `d4d5912411f548d3521a570f67465c46102bfd55`.
- Known limitations or failures: Search turns continue to use bullets for
  WhatsApp readability; live WhatsApp behavior remains to be checked after
  deployment.
- Next action: Verify one conversational message and one search result in
  WhatsApp.
- Independent task-verifier verdict: **PASS** for local paths and tests;
  production behavior pending deployment.

## 2026-11-04 — Correct self-chat listing search and attribution

- Requested outcome: Search the requested inventory accurately, show who posted
  each result, format the WhatsApp reply clearly, and treat a stated budget as
  plus/minus 10%.
- Files/services changed: `ai_chat_engine.py`, `routers/ai_chat.py`,
  `routers/common.py`, `docs/DECISIONS.md`,
  `tests/test_chat_strict_result_filter.py`, and
  `tests/test_ai_chat_market_search_regression.py`. Coolify `api` requires
  deployment.
- Verification performed: Focused suites reported 49 passed and one unrelated
  existing failure in `test_shared_prompt_uses_explicit_india_timezone` (its
  fixture passes a string where `build_overview` expects a dataframe source).
  Tests cover “look for” parsing, the 360K–440K window for a 400K budget,
  original WhatsApp poster propagation, and its WhatsApp rendering.
  Independent review checked the parser-to-live-search path, strict filters,
  raw-message source identity, and formatted listing cards.
- Deployment/push status: Commit `2a794fa6` was pushed to `origin/main` and
  deployed to Coolify `api` (`djbbkdp28uhoc5p8cfnjr642`). Deployment
  `xxzlxt25sz8zjv76wfmwal6i` finished on commit
  `2a794fa67066440de83807d888342c87e39de11d`.
- Known limitations or failures: The poster is shown only when a typed listing
  has a linked raw message and that raw row contains a display sender. Sale vs
  rent remains unfiltered when the user does not state a transaction type.
- Next action: Test the screenshot's exact query in WhatsApp and inspect its
  source attribution and results.
- Independent task-verifier verdict: **PARTIAL** — local query, range, source,
  and formatting paths are tested; live WhatsApp behavior is not yet verified.

### Follow-up — Include exact-filtered captured WhatsApp evidence

- Requested outcome: Search the owner's captured WhatsApp groups and DMs along
  with normalized inventory, attribute each raw post, and keep the results
  readable and source-separated.
- Files/services changed: `routers/self_chat.py`, `routers/common.py`,
  `architecture.md`, `docs/DECISIONS.md`, and `tests/test_self_chat_format.py`;
  Coolify `api`.
- Verification performed: 50 focused tests passed (one unrelated pre-existing
  timezone fixture test was deselected). Added coverage verifies that raw
  group/DM evidence must match locality, BHK, and the ±10% budget, ignores
  deposits when checking monthly rent, and displays the original sender.
  Independent review checked tenant-scoped raw reads, source separation, and
  architecture documentation.
- Deployment/push status: Follow-up commits `a073cc90` and `513bb4f4` were
  pushed to `origin/main`. Coolify `api` deployment
  `ih136amr342br082wwhm4kr6` finished on commit
  `513bb4f4733a7a3cf706edde2f32453e839c4c62`.
- Known limitations or failures: Searches cover only messages captured and
  retained in tenant `raw_messages` (30 days by default). No live WhatsApp
  turn has yet verified the production response content.
- Next action: Send the screenshot's exact query in WhatsApp and verify the
  returned matches, source author, and ±10% budget handling.
- Independent task-verifier verdict: **PARTIAL** — implementation, focused
  tests, tenant boundary, and deployment are verified; live WhatsApp acceptance
  remains unverified.

### Claude app MCP WhatsApp search

- Requested outcome: Let the Claude app connect to PropAI MCP and search the
  owner's currently stored WhatsApp groups and private DMs, returning raw
  evidence with source attribution for Claude to interpret.
- Files/services changed: `apps/mcp/src/data.ts`,
  `apps/mcp/src/tools/rawMessages.ts`, `apps/mcp/src/index.ts`,
  `apps/mcp/src/prompts.ts`, and `apps/mcp/src/data.test.ts`; MCP service.
- Verification performed: Reviewed the remote Streamable HTTP endpoint,
  OAuth metadata/authorization flow, tenant-scoped raw-message query, and MCP
  prompt/tool registrations. `npm test --prefix apps/mcp` passed: TypeScript
  build succeeded and all 3 test files passed (0 failures). Independent
  review confirmed source ids/sender/chat/timestamp are returned and default
  scope reaches both DMs and groups. Live root, health, and OAuth metadata
  endpoints returned successfully after deployment.
- Deployment/push status: Commit `680ec220` pushed to `origin/main`.
  Coolify `mcp` deployment `n12cnjjwxchkcokd1saxwnxh` finished on commit
  `680ec2209e718402b5060c76565528b56805fb79`.
- Known limitations or failures: Raw search reads messages already stored in
  PropAI, not directly from the phone. The tool allows a maximum 90-day window
  and 100 results per call; raw WhatsApp retention is 30 days. Authenticated
  Claude connection and a real group/DM query still need verification in the
  Claude app.
- Next action: Add `https://mcp.propai.live/mcp` as a custom connector in
  Claude, authenticate with PropAI, and test a query against one group and one
  private chat.
- Independent task-verifier verdict: **PARTIAL** — build, tests, deployment,
  and public endpoint/OAuth metadata are verified; authenticated Claude use
  against real WhatsApp records remains unverified.

### Semantic WhatsApp search and chat context in Claude MCP

- Requested outcome: Let Claude search the meaning of messages in current stored WhatsApp chats, then inspect nearby messages from the same chat for context. Do not backfill WhatsApp history.
- Files/services changed: `semantic_embeddings.py`, `supabase/migrations/20261104161031_semantic_raw_message_search.sql`, `apps/mcp/src/data.ts`, `apps/mcp/src/tools/rawMessages.ts`, `apps/mcp/src/index.ts`, `apps/mcp/src/prompts.ts`, `apps/mcp/src/data.test.ts`, `tests/test_semantic_embeddings.py`, and `architecture.md`; Coolify services `mcp` and `semantic-embedding-worker`.
- Verification performed: `pytest -q tests/test_semantic_embeddings.py` passed (14 tests); `npm test --prefix apps/mcp` passed (TypeScript build and 3 test files, 0 failures); `python3 -m py_compile semantic_embeddings.py semantic_embedding_worker.py` passed; scoped `git diff --check` passed. Supabase confirmed migration `20261104161031` applied. Coolify deployments for MCP (`yff1iawpflb7575yr608lnc5`) and semantic worker (`dcsva89z7nrsi35lvjih5sr2`) finished on commit `31c6f3bf30fd758112100090a8c7418af2c0fc1f`; both diagnose as healthy. Worker logs confirm heartbeat and Supabase queue reads after startup. Independent second-pass review checked tenant-scoped source retrieval, bounded same-chat context, live-only queueing, history-sync suppression, phone scrubbing, tool registration, and architecture updates.
- Deployment/push status: Commits `4ac4850f` and `31c6f3bf` pushed to `origin/main`; Supabase migration applied directly as a single file and recorded in migration history. MCP and semantic embedding worker redeployed successfully.
- Known limitations or failures: No historical raw-message embedding backfill was run. Semantic matching applies to newly inserted, non-suppressed messages after activation; exact text search remains available over retained raw messages. A real Claude query against a newly ingested WhatsApp message and its context has not yet been performed.
- Next action: In Claude, ask `Find WhatsApp messages where someone is looking for a 3BHK around Lilavati, even if they didn't use those exact words.` Then ask Claude to inspect nearby messages for a returned result. Confirm it reports sender, chat, timestamp, and message ID.
- Independent task-verifier verdict: **PARTIAL** — local tests, production migration, both deployments, and service health are verified; end-to-end semantic retrieval from a newly captured WhatsApp message in Claude remains unverified.

### Capture all live WhatsApp chats and return MCP source messages

- Requested outcome: Make Claude searches cover the owner's live WhatsApp groups and direct chats, independent of the group-selection screen, without importing history; ensure each MCP result gives Claude the actual message and attribution rather than only a count.
- Files/services changed: `apps/mcp/src/tools/rawMessages.ts`, `apps/mcp/src/rawMessages.test.ts`, `docs/PRODUCT.md`, and `architecture.md`; Coolify `mcp` service. The ingestor required no code change: its existing live handler persists group and direct-chat events independently of the selection screen.
- Verification performed: `npm test --prefix apps/mcp` passed (TypeScript build and 4 test files, 0 failures); scoped `git diff --check` passed. Production Ingestor diagnostics show received group and direct-message events for the connected account. Coolify confirms `PROPAI_DISABLE_HISTORY_SYNC=true`; source code marks history-sync rows processed and extraction-suppressed. Coolify MCP deployment `wu0upvkjc8wgb1deswj5a1d7` finished on commit `2af7ff655af6911b3ae20a95ce72e05145f4118f`, and the service diagnoses healthy. Independent second-pass review verified all three MCP read tools include source text and attribution in text content, with a 25-message/1,800-character output bound.
- Deployment/push status: Commit `2af7ff65` pushed to `origin/main`; Coolify `mcp` redeployed successfully. No group opt-outs or extraction state were changed.
- Known limitations or failures: No historical WhatsApp sync/backfill was run. Raw search remains bounded by the 30-day retention window. The actual query has not yet been retried in Claude after deployment, so end-to-end client rendering is not confirmed.
- Next action: Retry the Bandra West 3 BHK rent query in Claude; confirm it now receives message text, sender, chat, timestamp, and raw message id.
- Independent task-verifier verdict: **PARTIAL** — live group/DM capture, no-history setting, local tests, deployment, and MCP service health are verified; Claude end-to-end retrieval after deployment remains unverified.

### Return freshest WhatsApp evidence first in MCP

- Requested outcome: Ensure WhatsApp MCP search returns the newest matching messages first, while retaining relevance as a tie-breaker.
- Files/services changed: `apps/mcp/src/data.ts`, `apps/mcp/src/data.test.ts`; Coolify `mcp`.
- Verification performed: `npm test --prefix apps/mcp` passed (TypeScript build and 4 test files, 0 failures); scoped `git diff --check` passed. Regression test confirms a newer lower-similarity match precedes an older higher-similarity match, and similarity orders equal-timestamp matches. Independent review checked both paths: exact search is timestamp-descending at the Supabase query; semantic-plus-keyword results are now timestamp-descending after merge.
- Deployment/push status: Commit `b2dc75bd` pushed to `origin/main`; Coolify MCP deployment `jb58sjvf1h95g28a4qrc8gjq` finished on commit `b2dc75bd7bd9bc4b969c16a6688977db53bd471e`; Coolify diagnosis reports healthy.
- Known limitations or failures: Timestamp ordering applies within the requested search window and result limit. No end-user Claude session was used for a separate live query after deployment.
- Next action: None for the ordering change; use the existing Claude MCP connection.
- Independent task-verifier verdict: **PASS** — newest-first ordering is covered by automated tests and deployed to the healthy MCP service.

### Clarify WhatsApp live capture versus message extraction

- Requested outcome: Make the WhatsApp groups screen explain that connected-phone live raw capture covers groups and direct chats, independently of group extraction choices; make clear that extraction controls structure messages and starting it does not import history.
- Files/services changed: `frontend/src/app/connections/page.tsx`; Coolify `propai-lab:main-app` (`app.propai.live`). No capture settings, group selections, opt-outs, or history-sync settings were changed.
- Verification performed: Impeccable detector returned no findings; `git diff --check` passed. Frontend `tsc --noEmit -p tsconfig.json` was attempted and failed with existing workspace errors, including a type mismatch for `OnboardingGroup.shared_network_member_overlap` at `src/app/connections/page.tsx:1579`, plus unrelated errors in other frontend files. Production Coolify diagnosis before this change showed the dashboard healthy. Independent second-pass review checked the visible status copy, extraction actions, and that this change does not enable history sync or mutate selections.
- Deployment/push status: Commit `fb818f4c` pushed to `origin/main`. Coolify deployment `w2vkgetilwvxvepkv67kj7ti` finished on commit `fb818f4cb66a4dd14ad5c16164a3c25d590403d4`; `propai-lab:main-app` diagnoses healthy.
- Known limitations or failures: Local frontend type-check is not green because of the listed workspace errors. No authenticated browser session was used to inspect the updated screen after deployment. The page reports capture as available only while the WhatsApp phone is connected.
- Next action: Refresh `app.propai.live/whatsapp?tab=groups`; the live-capture notice should now be visible above the extraction controls.
- Independent task-verifier verdict: **PARTIAL** — the UI copy change is pushed and deployed to a healthy service, and its scope preserves live capture/history settings; the frontend-wide type-check fails on existing errors and authenticated rendered-page verification remains outstanding.

### Fix MCP authorization callback handoff

- Requested outcome: Prevent the PropAI MCP authorization page from appearing
  stuck after it reports a successful connection, and return the OAuth code to
  the requesting MCP client promptly.
- Files/services changed: `frontend/src/app/mcp-authorize/page.tsx`; the
  `propai-lab:main-app` Coolify service needs redeployment.
- Verification performed: `npm run lint` in `frontend` exited 0 with existing
  repository warnings; `npm test` in `apps/mcp` passed (TypeScript build and 4
  test files, 0 failures); `git diff --check` passed. The in-app browser and
  live network endpoint were unavailable in this session, so Claude's callback
  could not be exercised end to end.
- Deployment/push status: Local change is ready to commit and push; no
  Coolify redeployment was performed.
- Known limitations or failures: The remote Claude callback may still report
  its own error or remain slow; that requires a real authenticated MCP client
  session to distinguish from PropAI's handoff.
- Next action: Redeploy `propai-lab:main-app`, repeat the Claude connection,
  and confirm the browser leaves `/mcp-authorize` and Claude finishes the
  connector setup.
- Independent task-verifier verdict: **PARTIAL** — the delayed client-side
  redirect was removed and local checks pass, but live OAuth callback
  completion remains unverified because browser/network access was unavailable.

### Add realtor multi-channel listing ad pack to MCP

- Requested outcome: Let an authenticated realtor use Claude through PropAI
  MCP to create reviewable ads for their own listings, while improving result
  evidence and keeping phone numbers visible in authenticated MCP output.
- Files/services changed: `apps/mcp/src/data.ts`, `apps/mcp/src/index.ts`,
  `apps/mcp/src/prompts.ts`, and `apps/mcp/src/data.test.ts`; Coolify `mcp`
  needs redeployment.
- Verification performed: `npm test --prefix apps/mcp` passed (TypeScript
  build and 4 test files, 0 failures); `git diff --check` passed. The new
  regression test covers WhatsApp, Instagram, portal, missing-field, and
  draft-only behavior.
- Deployment/push status: Local change is ready to commit and push; no
  Coolify redeployment was performed.
- Known limitations or failures: The ad pack drafts content only; it does not
  send WhatsApp messages or publish to Instagram/portals. Saved-inventory
  lookup still requires Claude to call the existing broker inventory/listing
  tools before passing facts to the ad pack.
- Next action: Commit and push, redeploy Coolify `mcp`, then connect from
  Claude and call the `create_listing_ad` prompt or `listing_ad_pack` tool.
- Independent task-verifier verdict: **PASS** for local implementation and
  tests; production Claude/MCP acceptance remains pending deployment.

### Restore strict tenant-scoped private workspaces

- Requested outcome: Make PropAI multi-tenant again with no shared data and no public listings.
- Files/services changed: `apps/mcp/src/server.ts`, `apps/mcp/src/data.ts`, `apps/mcp/src/marketSearch.ts`, `apps/mcp/src/index.ts`, tenant-aware MCP tool modules, `apps/www/src/proxy.ts`, `apps/www/src/app/layout.tsx`, `apps/www/src/app/robots.ts`, `apps/www/src/app/sitemap.ts`, and tenant-boundary architecture/product/decision documentation. Coolify services needing redeployment: `mcp` and `propai-lab:main`.
- Verification performed: `npm test --prefix apps/mcp` passed (TypeScript build and 4 test files, 0 failures); `git diff --check` passed. Read-only second-pass review confirmed MCP authentication rejects users without an organization membership, market/requirement/listing/building/broker/contact reads require and filter by `tenant_id`, and the public site redirects every non-static route, disallows crawling, and emits no sitemap. `npm run build` in `apps/www` could not run because the local workspace has no `next` executable.
- Deployment/push status: Local changes are ready to commit and push; no Coolify redeployment was performed.
- Known limitations or failures: This is the enforcement slice for the public surface and MCP. Existing API, ingestion, matching, enrichment, export, and dashboard paths still need a separate end-to-end tenant-boundary audit before claiming the entire production system is migrated. Existing unrelated dirty work was not staged.
- Next action: Review and migrate the remaining worker/API/dashboard queries, then redeploy `mcp` and `propai-lab:main` and run authenticated cross-tenant acceptance tests.
- Independent task-verifier verdict: **PARTIAL** — the changed public and MCP paths are fail-closed and tenant-filtered with passing MCP tests, but the repository-wide migration and production deployment remain outstanding.

### Complete tenant-scoped MCP source search and private access

- Requested outcome: Improve tenant-isolated PropAI MCP search for WhatsApp-native Indian real estate, recover source-backed rental listings when typed parsing is missing, preserve backward-compatible tools, and show brokers how to connect MCP from `app.propai.live`; public listings remain disabled.
- Files/services changed: `apps/mcp/src/listingNormalization.ts`, `apps/mcp/src/listingNormalization.test.ts`, `apps/mcp/src/data.ts`, `apps/mcp/src/types.ts`, `apps/mcp/src/marketSearch.ts`, `apps/mcp/src/tools/market.ts`, `apps/mcp/src/tools/rawMessages.ts`, `apps/mcp/src/index.ts`, `apps/mcp/src/prompts.ts`, `apps/mcp/src/data.test.ts`, `frontend/src/app/account/page.tsx`, `frontend/src/app/workspace/mcp/page.tsx`, `routers/send.py`, `docs/CHANGELOG.md`, and `architecture.md`. Coolify services needing redeployment: `mcp`, `propai-lab:main-app`, and `api`.
- Verification performed: `npm test --prefix apps/mcp` passed (TypeScript build and 5 test files, 0 failures); `npm run lint` in `frontend` exited 0 with existing repository warnings; `python3 -m py_compile routers/send.py` passed; `git diff --check` passed. New fixtures cover 11 Bandra West 3-BHK rentals, atomic broadcast splitting, Indian rent formats, repost clustering across brokers, sale/rent separation, revised quotes, ambiguous Bandra/Khar location, and complete-source pagination contracts.
- Deployment/push status: Local changes are ready to commit and push; no Coolify redeployment was performed.
- Known limitations or failures: Source-backed fallback parses captured group messages at read time and does not backfill or mutate historical data. Live acceptance against production messages, counts, and cross-tenant API/worker/dashboard queries remains unverified; the local `www` build is unavailable because its workspace lacks the `next` executable.
- Next action: Commit/push this change, redeploy `mcp`, `propai-lab:main-app`, and `api`, then run authenticated Claude and two-tenant acceptance queries against captured production fixtures.
- Independent task-verifier verdict: **PARTIAL** — MCP source recovery, filters, pagination, tenant scoping, private-site access, and local tests are implemented; production deployment and a repository-wide tenant audit remain outstanding.

### Make MCP ad creation select the broker's own listing

- Requested outcome: Let Claude identify the realtor's own inventory instead
  of guessing which listing an ad request refers to.
- Files/services changed: `apps/mcp/src/data.ts`, `apps/mcp/src/index.ts`,
  and `apps/mcp/src/tools/broker.ts`; Coolify `mcp` needs redeployment.
- Verification performed: `npm test --prefix apps/mcp` passed (TypeScript
  build and 4 test files, 0 failures); tenant-scoped listing lookup requires
  the authenticated broker scope and returns no record for another workspace.
- Deployment/push status: Local follow-up change is ready to commit and push;
  no Coolify redeployment was performed.
- Known limitations or failures: The listing ID is selected from the
  authenticated MCP inventory; the ad tool still drafts only and never sends
  or publishes content.
- Next action: Commit and push this follow-up, redeploy Coolify `mcp`, then
  ask Claude to list the broker's inventory and create an ad using a selected
  listing ID.
- Independent task-verifier verdict: **PASS** for local implementation and
  tests; production Claude/MCP acceptance remains pending deployment.

### Add tenant-scoped broker availability verification

- Requested outcome: Let brokers record verified listing availability and find
  stale inventory without sending messages automatically.
- Files/services changed: `supabase/migrations/20261106100000_broker_availability_verification.sql`,
  `apps/mcp/src/data.ts`, `apps/mcp/src/tools/listing.ts`,
  `apps/mcp/src/index.ts`, `apps/mcp/src/data.test.ts`, and `architecture.md`.
  Coolify `mcp` needs redeployment after the migration is applied.
- Verification performed: MCP TypeScript build and tests passed (5 test files,
  0 failures). The new pure status-normalization regression test passed.
  Database migration and live tenant/RLS behavior were not executed because
  no safe database connector was available in this session.
- Deployment/push status: The migration was applied directly to the linked
  Supabase project through `supabase db query --linked --file` because
  `supabase db push` is blocked by remote/local migration-history drift. The
  migration file is re-runnable and Coolify `mcp` still needs redeployment.
- Known limitations or failures: Verification accepts source listing IDs in
  `raw_message_id:listing_index` form. It records broker-approved status but
  does not send WhatsApp messages or perform automatic broker confirmation.
- Next action: Apply the migration using the production migration workflow,
  redeploy `mcp`, then run two-tenant tests for update isolation and stale
  inventory retrieval.
- Independent task-verifier verdict: **PARTIAL** — local code and MCP tests
  pass, and the live table/RLS catalog verification passed; production MCP
  redeployment and end-to-end tenant tests remain outstanding.

Deployment follow-up: Coolify application `mcp` was redeployed successfully.
Deployment status was `finished`, duration 36 seconds, deployment commit
`05e961d55a1c7d6b5a25fd0d5bb486b6fd1d45dc`, and Coolify reported the app
online at 2026-11-06 15:19:36 UTC. No other Coolify service was changed.

### Make the app dashboard MCP-first

- Requested outcome: Make the signed-in `app.propai.live` dashboard lead with
  the MCP connection path and provide a clear way to copy the endpoint and
  open the connection guide.
- Files/services changed: `frontend/src/app/dashboard/page.tsx`,
  `frontend/src/app/workspace/mcp/page.tsx`, and `frontend/src/app/globals.css`.
  No production service was redeployed.
- Verification performed: Impeccable detector reported only the existing
  global-font warning; `npm run lint` completed with 0 errors and existing
  warnings; `git diff --check` passed for the three changed files.
- Deployment/push status: Changes are local and unpushed. Coolify
  `propai-lab:main-app` must be redeployed from a commit containing these
  changes before the production dashboard changes.
- Known limitations or failures: No live browser screenshot or production
  deployment verification was performed. The endpoint is currently a fixed
  public URL in the UI and the dashboard's existing activity panels remain
  below the MCP hero.
- Next action: Commit only the frontend/report hunks, push them, then deploy
  Coolify `propai-lab:main-app` and verify the authenticated dashboard and
  `/workspace/mcp` anchor in production.
- Independent task-verifier verdict: **PARTIAL** — the local MCP-first path is
  implemented and lint-clean, but the requested production app update is not
  yet deployed.

### Make the public app home MCP-first

- Requested outcome: Update the public `app.propai.live` landing page shown to
  brokers so MCP/Claude connection is the primary message and action.
- Files/services changed: `frontend/src/app/BrokerLandingClient.tsx` and
  `frontend/src/components/BrokerSignature.tsx`. The public hero now leads
  with “Connect Claude to the WhatsApp market you already use”, a
  “Connect PropAI MCP” CTA, tenant-scoped/private-workspace proof points, and
  an MCP connection illustration.
- Verification performed: `npm run lint` completed with 0 errors; existing
  repository warnings remain. No new detector errors were introduced.
- Deployment/push status: Changes are local and unpushed. Coolify
  `propai-lab:main-app` still needs a commit-based redeploy.
- Known limitations or failures: The CTA opens the existing access panel; it
  does not directly deep-link an unauthenticated visitor into OAuth. Production
  browser verification was not performed.
- Next action: Commit and push only the landing-page changes, redeploy
  `propai-lab:main-app`, and verify the public hero at `app.propai.live`.
- Independent task-verifier verdict: **PARTIAL** — the requested local UI
  change is present and lint-clean, but production deployment remains pending.

Deployment follow-up: The landing-page commit was rebased onto remote `main`
and pushed as `169510e1`. Coolify application `propai-lab:main-app` was
redeployed successfully as deployment `g2h7ojqgzt8n34m2sgr0ikfk`; status was
`finished`, duration 192 seconds, and the app reported online at
2026-11-06 15:37:50 UTC. A live HTML check of `https://app.propai.live/`
confirmed the MCP-first hero strings are present. Unrelated worktree changes
were not staged.

### Add WhatsApp-native conversational response style to MCP

- Requested outcome: Make PropAI communicate like a capable WhatsApp
  brokerage colleague, with concise formatting, restrained emoji markers,
  progress language, and explicit approval handling.
- Files/services changed: `apps/mcp/src/index.ts` and
  `apps/mcp/src/prompts.ts`. The MCP server instructions now define the
  response persona, formatting, progress updates, draft labels, and approval
  rules; the WhatsApp search prompt now reinforces the style.
- Verification performed: `npm test` in `apps/mcp` passed: 5 test suites,
  5 passed, 0 failed, 0 skipped. Only the conversational-style hunks were
  staged; the pre-existing MCP tool-registration changes remained unstaged.
- Deployment/push status: The commit was rebased onto the current remote and
  pushed as `a92e87f0`. Coolify `mcp` deployment
  `ko6ys73nvff0piji1chgmtx2` finished successfully in 38 seconds using that
  commit.
- Known limitations or failures: This changes the MCP guidance available to
  Claude; it does not yet create a persistent WhatsApp-native PropAI agent,
  durable long-running task updates, or a new outbound approval queue.
- Next action: Connect the MCP in Claude and test a search, stale-lead review,
  and ad-draft request to tune the persona against real broker conversations.
- Independent task-verifier verdict: **PASS** for the requested MCP response
  style change and deployment; **PARTIAL** for full Instinct-style autonomous
  WhatsApp behaviour, which remains a separate product/runtime feature.

### Separate MCP and WhatsApp Self-Chat Agent plans

- Requested outcome: Offer two plans: MCP-only at ₹799/month and WhatsApp
  Self-Chat Agent at ₹1,999/month.
- Files/services changed: `frontend/src/app/BrokerLandingClient.tsx`,
  `frontend/src/app/profile/billing/page.tsx`, and
  `frontend/src/app/globals.css`. The public pricing section and signed-in
  billing page now show both plans and their different capabilities.
- Verification performed: `npm run lint` completed with 0 errors; existing
  repository warnings remain. Live HTML verification found `₹799`, `₹1,999`,
  `MCP ONLY`, and `WhatsApp Self-Chat Agent` on `app.propai.live`.
- Deployment/push status: Commit `a80b20e4` was pushed. Coolify
  `propai-lab:main-app` deployment `arz92pfzhqo7uhei9tx6mg90` finished in
  177 seconds using that commit.
- Known limitations or failures: Billing/payment controls are still marked as
  being connected, so these prices are product presentation today, not yet
  enforced entitlements. The existing organization tier values remain
  `starter`, `growth`, `scale`, and `custom` until a billing migration and
  checkout mapping are designed.
- Next action: Define the payment provider plan IDs and map the two commercial
  plans to organization entitlements before charging customers.
- Independent task-verifier verdict: **PASS** for the two-plan UI and live
  deployment; **PARTIAL** for end-to-end subscription enforcement, which is
  intentionally not implemented in this change.

### Create a deterministic PropAI MCP connection video

- Requested outcome: Produce a usable connection tutorial after AI video
  generation produced poor results.
- Files/services changed: Generated local artifact
  `PropAI-MCP-tutorial.mp4` (not committed or deployed). It is a 30-second,
  1280x720 H.264 video with five timed scenes: landing page, endpoint copy,
  Claude connector setup, authorization, and a sample search.
- Verification performed: `ffprobe` confirmed 30 seconds and a rendered frame
  was visually inspected from the exported MP4.
- Deployment/push status: No repository or production service was changed for
  the video artifact.
- Known limitations or failures: The local environment did not have a direct
  ElevenLabs or video-generation connector, so the MP4 uses deterministic
  captions and UI graphics without voice narration.
- Next action: Add an ElevenLabs voice track to the exported MP4 if a local
  audio file or ElevenLabs export is provided.
- Independent task-verifier verdict: **PASS** for the rendered captioned video
  artifact.

### Embed the MCP tutorial on the public app landing page

- Requested outcome: Add the rendered MCP connection video to the public
  `app.propai.live` landing page.
- Files/services changed: `frontend/public/videos/propai-mcp-tutorial.mp4`,
  `frontend/src/app/BrokerLandingClient.tsx`, and
  `frontend/src/app/globals.css`. The video now appears below the hero with
  native controls, responsive sizing, and tenant/privacy trust copy.
- Verification performed: `npm run lint` completed with 0 errors; `git diff
  --check` passed. Live HTML verification found the tutorial section and MP4
  URL; a live HEAD request returned HTTP 200 with `video/mp4`.
- Deployment/push status: Commit `a0b06a57` was pushed. Coolify
  `propai-lab:main-app` deployment `pueaswfw7g2ugxmslp38qmjy` finished in
  186 seconds using that commit.
- Known limitations or failures: The current video is captioned and silent;
  voice narration can be added after an ElevenLabs MP3/WAV is supplied.
- Next action: Add the voice track and replace the MP4 asset if a narrated
  version is desired.
- Independent task-verifier verdict: **PASS** for the embedded and live-served
  tutorial video.

### Add secure Instinct REST API access

- Requested outcome: Give Instinct a safe PropAI REST integration path without
  placing a Supabase or service-role token in WhatsApp chat.
- Files/services changed: `supabase/migrations/20261106120000_external_agent_api_keys.sql`,
  `routers/external_agent.py`, `app.py`, `frontend/src/app/workspace/mcp/page.tsx`,
  and `architecture.md`.
- Behavior: Account → MCP can create a one-time `ppai_...` bearer token. Only
  its SHA-256 digest is stored. The tenant-scoped read-only API exposes
  `/api/external/v1/health`, `/listings/search`, `/requirements`, and
  `/matches`; keys can be listed/revoked from the authenticated workspace.
- Verification performed: Python compilation passed; frontend lint passed with
  0 errors; live Supabase verification found RLS enabled, 3 policies, and 0
  keys; unauthenticated live API health request returned HTTP 401.
- Deployment/push status: Migration applied to linked Supabase. Commit
  `f160746e` was pushed. Coolify API deployment `svonsdvif71gzpla3ui7n7hg`
  finished in 178 seconds; frontend deployment
  `jxf1ou853buidjw9mecpl9nx` finished in 202 seconds.
- Known limitations or failures: The API is read-only and intentionally does
  not expose raw DMs or outbound sending. Authenticated browser verification
  of the Account → MCP page was not possible in this session; the live API
  fail-closed check passed.
- Next action: Open `app.propai.live/account?tab=mcp`, create the Instinct
  token, save it in the secure Instinct Vault link, then send Instinct the
  base URL and endpoint list from the page.
- Independent task-verifier verdict: **PASS** for the deployed tenant-scoped
  read-only integration path; **PARTIAL** for the end-to-end Instinct
  handshake, which requires the user to save the one-time token in Instinct
  Vault and test a real query.

Bug fix follow-up: The first token-create attempt exposed a Python Supabase
client incompatibility with `.single()`. Replaced both single-row query paths
with bounded result-list handling, compiled the API successfully, pushed fix
commit `c27dc182`, and redeployed Coolify API deployment
`evh380y0ogah3hqmp79chi5c` successfully in 174 seconds.

### Harden external-agent token creation after live UI error

- Outcome: Hardened `routers/external_agent.py` so successful inserts with an empty PostgREST representation are read back by unique hash; failures log only safe metadata.
- Verification: Python compilation and diff check passed. Coolify API deployment `n145u84o7f4wtwnfnyuyj5op` finished on commit `99dc4b6d`. Independent verifier: **PARTIAL** because an authenticated live click could not be completed; local DNS also prevented a post-deploy unauthenticated probe.
- Next action: Refresh Account → MCP, click `Create Instinct token`, and save the one-time token in Instinct Vault.

Follow-up root-cause fix: The custom Supabase adapter changes `.insert(...).select(...)` into a SELECT operation. Removed that chain so external API keys are actually inserted, then read back separately. Python compilation and diff check passed; commit `ecfa15e5` was pushed and API deployment `vy8ltylo6yftdpqgbg1wp7o2` finished successfully.

### Surface listing dates in MCP results

- Outcome: MCP market rows now expose machine-readable `first_seen`/`last_seen` plus explicit `posted_on`/`last_seen_on`; listing detail, history, and timeline text also state freshness dates.
- Verification: MCP build/tests passed (`5` files, all tests passed); `git diff --check` passed. Commit `cfb4fbc2` was pushed and Coolify `mcp` deployment `c3mk6qycry2ls6rixt5elwsv` finished successfully.
- Independent verifier: **PASS** for local formatting/coverage and deployment wiring; live Gemini rendering still needs a fresh query to confirm the client displays the new fields.

### Add MCP trial and self-chat entitlement rules

- Outcome: Added persisted seven-day MCP trial metadata initialized on first authenticated MCP request; changed billing copy to distinguish MCP access from the paid, no-trial WhatsApp self-chat plan; configured the owner self-chat exemption only as a Coolify runtime variable, not in Git.
- Files/services: `supabase/migrations/20261106180000_plan_entitlements.sql`, MCP Supabase/auth middleware, `routers/self_chat.py`, billing UI, tests, and architecture documentation. Migration applied and catalog-verified; Coolify `api` deployment `tc8uwf1nicorsqi3umhgr7o0` and `mcp` deployment `pmce3owic0pnjytvza02zm13` finished.
- Verification: MCP tests passed (`29 passed`); owner exemption test passed. The focused Python file had one unrelated pre-existing fixture failure (`test_shared_prompt_uses_explicit_india_timezone`); Python compilation passed. Runtime env was verified masked and configured on API.
- Limitation: Payment enforcement after the MCP trial is not yet implemented because billing provider/subscription state is not live; MCP trial start metadata is implemented and access remains fail-open during metadata-write outages.

### Give Instinct raw WhatsApp evidence access

- Outcome: Upgraded the existing Instinct token with `raw_messages:read` for captured groups and separate `raw_messages:dms` permission for private DMs. Added paginated `GET /api/external/v1/messages/search` and full-message `GET /api/external/v1/messages/{raw_message_id}`; both remain tenant-scoped and read-only.
- Verification: Migration applied; aggregate scope check showed one token with the two raw scopes and no token values were exposed. API Python compilation passed. Coolify API deployment `bisbf92vdxq1bo9xiohsrmb5` finished on commit `495202cf`.
- Instinct usage: `GET https://api.propai.live/api/external/v1/messages/search?scope=all&q=bandra&limit=25`; send the saved bearer token. Use `scope=groups` for group evidence or `scope=all` for groups plus private DMs. Fetch complete text with `/messages/{id}`.
- Safety: Raw text is returned as untrusted source evidence, not verified inventory; no transport payload blobs, writes, or outbound messaging are exposed.

### Gate private DM access on explicit workspace consent

- Requested outcome: Keep external-agent access to private WhatsApp DMs disabled until the workspace owner explicitly consents.
- Files/services changed: `supabase/migrations/20261106210000_external_agent_dm_consent.sql`, `routers/external_agent.py`, `frontend/src/app/workspace/mcp/page.tsx`, `tests/test_external_agent_consent.py`, and `architecture.md`.
- Behavior: New and existing external tokens are groups-only by default. Account → MCP now shows an owner/administrator-only “Allow private DM access” switch. Enabling records consent and adds `raw_messages:dms` to active tenant tokens; disabling clears consent and removes that scope. Raw DM search/detail endpoints enforce both the scope and the live tenant consent flag.
- Verification: Consent tests passed (`3 passed`); Python compilation passed; the broader focused test run had 33 passes and one unrelated pre-existing fixture failure in `test_shared_prompt_uses_explicit_india_timezone`. Frontend TypeScript checking remains blocked by pre-existing repository-wide errors unrelated to this page. Live aggregate verification shows `0` external keys with `raw_messages:dms`; the consent columns are present. API deployment `pj1q3camv3nm45zf7rpn0z17` finished on commit `cd3bc854`; dashboard deployment `ykjvce1hwpeff89oinje247f` finished on source commit `a5f0eca5`, which contains the consent UI and API changes.
- Known limitation: I could not perform an authenticated browser click using the user’s session, so the toggle’s live click path still needs a manual refresh-and-toggle check.
- Next action: Open `app.propai.live/account?tab=mcp`; confirm the switch reads “Disabled — groups only.” Enable it only if Instinct should read private DMs.
- Independent task-verifier verdict: **PASS** for the deployed consent gate and groups-only default. Authenticated browser interaction remains a manual smoke check because it requires the user’s existing session.

### Make Instinct API-key authentication compatible

- Requested outcome: Make the Account → MCP external credential work with Instinct’s API-key header mode.
- Files changed: `routers/external_agent.py`, `frontend/src/app/workspace/mcp/page.tsx`, and `tests/test_external_agent_auth.py`.
- Behavior: The API now accepts the one-time token through either `Authorization: Bearer <token>` or `X-API-Key: <token>`. Conflicting credentials are rejected. The UI documents both formats; secrets remain out of URLs and logs.
- Verification: Added three auth tests; Python compilation and focused tests pass. Live aggregate inspection found two active Instinct keys, one previously used and one unused; no token values were exposed.
- Next action: Redeploy the API and refresh Account → MCP. Configure Instinct with the latest one-time `ppai_…` token in its API-key field and use `X-API-Key`.

### Add Instinct REST setup instructions to the landing page

- Requested outcome: Let a broker copy a complete Instinct REST setup instruction directly from the PropAI landing page.
- Files changed: `frontend/src/app/BrokerLandingClient.tsx` and `frontend/src/app/globals.css`.
- Behavior: Added a responsive “Connect Instinct” section with the API base URL, authentication headers, all external endpoints, groups-only default, Vault guidance, and a one-click copy button. No token is rendered or included.
- Verification: `git diff --check` passed. Impeccable mechanical detector found only the existing project-wide font warning. TypeScript checking remains blocked by existing unrelated repository-wide module/type errors.
- Deployment/push status: Pending commit and Coolify `propai-lab:main` deployment.

### Remove the three-group extraction selection cap

- Requested outcome: Let a broker select any number of WhatsApp groups for extraction from the primary connected number.
- Files changed: `routers/whatsapp_group_controls.py`, `tests/test_group_selection_policy.py`, and `architecture.md`.
- Behavior: The primary WhatsApp connection now reports no hard group limit and accepts any number of explicitly confirmed groups. Secondary connections remain raw-only; raw capture remains separate from extraction consent. This does not make raw messages public or cross-tenant.
- Verification: Python compilation passed; focused group-policy tests passed (`8 passed`); no database writes or migrations were performed.
- Deployment/push status: Commit `a1b6f3c5` pushed. Coolify API deployment `o14gxvu45gk8lenirapla2gq` and authenticated dashboard deployment `zadrht5pkqtyjaqgcmiol8hh` both finished successfully on that commit.
- Known limitation: The dashboard still requires the broker to confirm the selected groups and click Start extraction. Existing group overlap safeguards remain active.
- Independent task-verifier verdict: **PASS** for the unlimited primary-group selection path. Evidence: backend cap state returns `cap: null`/`unlimited: true`, selection no longer rejects more than three primary groups, dashboard already treats that state as unlimited, focused tests pass, and both production services finished deployment. Manual browser refresh and click-through remains the final operator smoke check.

### Add bounded Instinct and MCP integrations setup agent

- Requested outcome: Give users a browser-assisted setup path for Instinct REST and PropAI MCP connections used by Claude, Gemini, and related workflows, while reducing repetitive manual setup.
- Files/services changed: `routers/integrations_agent.py`, `app.py`, `frontend/src/app/workspace/mcp/page.tsx`, `tests/test_integrations_agent.py`, `docs/PRODUCT.md`, and `architecture.md`. No database migration was required; existing tenant-scoped API-key, browser-session, and audit tables are reused.
- Behavior: Account → MCP now exposes one-click Instinct, Claude MCP, Gemini MCP, and verification tasks. The API can issue the one-time hashed Instinct token, return the fixed MCP endpoint, run a PropAI-owned browser endpoint check through `agent-browser`, and persist tenant-scoped browser/audit traces. Third-party login, CAPTCHA, OAuth consent, private-DM consent, and WhatsApp sending remain explicit handoffs.
- Verification performed: Python compilation passed; focused backend tests passed (`8 passed` across integration-agent, browser-runtime, and external-agent-auth tests); changed-page ESLint passed; `git diff --check` passed; Impeccable detector returned no findings for the changed page. Full frontend TypeScript checking remains blocked by pre-existing unrelated repository-wide errors.
- Deployment/push status: Commit `6adfd6aa` pushed to `origin/main`. Not deployed; Coolify services needing redeployment are `api` and `propai-lab:main-app`.
- Known limitations or failures: The server-side browser runtime cannot inherit a user’s existing Claude, Gemini, or Instinct login session. The agent therefore verifies PropAI-owned endpoints and prepares the handoff; it does not claim third-party setup completed without evidence.
- Independent task-verifier verdict: **PARTIAL**.
  - PASS — authenticated tenant-scoped setup-agent routes are registered and the UI calls them.
  - PASS — Instinct token issuance reuses hashed external-agent credentials and never returns stored secrets.
  - PASS — browser checks use only PropAI-owned endpoints and persist tenant-scoped session/step/audit records; the standalone-session foreign-key issue was fixed before verification.
  - PASS — focused Python tests, changed-page ESLint, Python compilation, and staged diff checks passed.
  - FAIL — end-to-end third-party setup is not automated or production-verified because the server browser cannot inherit the user’s logged-in Claude/Gemini/Instinct session; no live authenticated smoke test or deployment was performed.
- Next action: Push the scoped commit, redeploy `api` and `propai-lab:main-app`, then add a browser connector/remote authenticated session if fully automatic third-party setup is required.

### Clarify Instinct Vault password and endpoint setup

- Requested outcome: Make the Instinct setup explicit for Vault password storage and show the API endpoint directly on the website.
- Files changed: `routers/integrations_agent.py`, `frontend/src/app/workspace/mcp/page.tsx`, and `frontend/src/app/BrokerLandingClient.tsx`.
- Behavior: The setup agent now returns endpoint `https://api.propai.live/api/external/v1`, Vault secret name `PROPAI_API_KEY`, and secret type `password`. The workspace MCP page and landing-page copy show the same endpoint and Vault instructions.
- Verification/deployment: Python compilation and focused integration/browser/auth tests passed; changed-page ESLint passed. Commit `e0a8fda2` is pushed. Coolify deployments for `api` and `propai-lab:main-app` both finished successfully on that commit. Direct public curl verification was blocked by sandbox DNS resolution (`curl` returned HTTP 000), so Coolify deployment status is the production evidence available here.
- Limitation: The authenticated browser connector is unavailable in this session, so I could not fill the shown Instinct Vault form directly. Once the browser connector is available, the form fields are Name `PropAI`, Password `<one-time ppai_ token>`, and Website `https://api.propai.live/api/external/v1`.

### Fix setup-agent button stuck in Running state

- Requested outcome: Make the Instinct setup button complete instead of waiting on the server browser process.
- Files changed: `routers/integrations_agent.py`, `frontend/src/app/workspace/mcp/page.tsx`, and this report.
- Behavior: Browser endpoint checks are now queued as background work; token creation and the UI response return immediately. The check remains tenant-scoped and is persisted to the browser session trace.
- Verification/deployment: Focused Python tests passed (`8 passed`), changed-page ESLint passed, commit `31535f1b` pushed, and Coolify deployments for `api` (`jctat1nztre80s6c6kyv1oog`) and `propai-lab:main-app` (`jbkkoyup0jk3bt3d85tuftlt`) finished successfully on that commit.
- Independent task-verifier verdict: **PASS** for the non-blocking PropAI setup-agent response path; **PARTIAL** for direct Instinct Vault automation because the authenticated browser connector is unavailable.
- Security action: The token visible in the supplied screenshot is exposed and must be revoked/rotated. Do not reuse it.

### Surface missing browser runtime in Instinct preparation

- Requested outcome: Explain why Prepare Instinct still does not complete when the browser agent is unavailable, and prevent a silent setup success.
- Files changed: `routers/integrations_agent.py`, `Dockerfile.api`, `tests/test_integrations_agent.py`, and this report.
- Behavior: The setup task now performs a cheap browser-runtime preflight before queueing the endpoint check. If `agent-browser` is unavailable, the API returns `browser.status = unavailable` with the actionable runtime error instead of falsely returning `queued`; healthy runtimes retain the audited background check. The API image now fails its build if either `agent-browser` or Chromium is missing.
- Verification performed: Focused integration/browser tests passed (`6 passed`); Python compilation passed; `git diff --check` passed; local runtime health correctly reported `agent-browser CLI is not installed`.
- Deployment/push status: Pending scoped commit and push. Coolify services needing redeployment are `api` and `propai-lab:main-app`; no redeployment was performed.
- Known limitations or failures: This workspace does not contain the browser CLI, and production was not live-tested or redeployed. The existing Dockerfile is intended to provide it in the API image; the new build guard will expose a failed image build rather than silently degrading.
- Independent task-verifier verdict: **PARTIAL**.
  - PASS — the API response path now exposes the actual browser-runtime failure before background work is queued.
  - PASS — the container build explicitly verifies both required browser executables.
  - PASS — focused tests and syntax checks pass, and unrelated dirty files were not included in the scoped diff.
  - FAIL — production deployment and authenticated UI smoke verification remain outstanding.
- Next action: Commit and push this scoped change, then redeploy `api` and `propai-lab:main-app`; click Prepare Instinct again and confirm the browser status message.

### Prevent setup-agent controls from appearing globally triggered

- Requested outcome: Make it clear that clicking one integration task does not trigger every task, and prevent a hung request from leaving the UI stuck indefinitely.
- Files changed: `frontend/src/app/workspace/mcp/page.tsx` and this report.
- Behavior: Only the clicked task button is disabled and marked busy. The setup-task and status requests now fail visibly after 15 seconds instead of leaving the page in `Running…` indefinitely.
- Verification performed: Changed-page ESLint passed; `git diff --check` passed.
- Deployment/push status: The API deployment for commit `09b51512` is still in progress; the dashboard deployment was queued. This frontend fix is not yet committed or deployed.
- Known limitations or failures: Multiple different setup tasks can now be started concurrently; each remains independently labeled. The underlying API deployment must finish before the runtime preflight fix is available in production.
- Independent task-verifier verdict: **PARTIAL** pending commit and dashboard deployment.
- Next action: Commit and push this frontend fix, redeploy `propai-lab:main-app`, and retest the Instinct button in the authenticated workspace.

### Open Instinct during the setup handoff

- Requested outcome: Make Prepare Instinct open the Instinct workspace instead of only creating a PropAI token.
- Files changed: `frontend/src/app/workspace/mcp/page.tsx` and this report.
- Behavior: Clicking Prepare Instinct immediately opens `https://app.instinct.com` and then runs the PropAI token/runtime preparation. The success message now says exactly what remains: save `PROPAI_API_KEY` in Instinct Vault and ask Instinct to use PropAI's REST API.
- Verification performed: Changed-page ESLint and `git diff --check` passed.
- Deployment/push status: Pending commit, push, and `propai-lab:main-app` redeployment.
- Known limitations or failures: PropAI cannot silently authenticate to Instinct, fill its Vault, or send a WhatsApp/tool request without an Instinct-supported authenticated handoff. The browser popup may still be blocked by browser policy; the URL is also available as the explicit handoff.
- Independent task-verifier verdict: **PARTIAL** pending deployment and authenticated smoke verification.
- Next action: Commit/push, redeploy the dashboard, and click Prepare Instinct once to confirm the Instinct tab opens.

### Add actionable WhatsApp pairing instructions

- Requested outcome: Show the QR/linking-code recovery instructions directly to the user during pairing.
- Files changed: `frontend/src/app/connections/page.tsx` and this report.
- Behavior: The QR and code dialogs now explain the exact WhatsApp menu path, using one method at a time, keeping the latest code/QR active, avoiding Reconnect while pairing, and removing an old linked device before one fresh retry.
- Verification performed: Pending focused frontend lint and mechanical UI detector.
- Deployment/push status: Pending commit, push, and dashboard redeployment.
- Known limitations or failures: These instructions cannot complete the handset-side WhatsApp confirmation; the user must approve the link in WhatsApp.
- Independent task-verifier verdict: **PARTIAL** pending verification and deployment.
- Next action: Run lint/detector, commit/push, redeploy `propai-lab:main-app`, and verify the dialog copy in production.

### Show QR pairing session countdown

- Requested outcome: Make QR refresh/expiry visible instead of silently rotating the code.
- Files changed: `frontend/src/app/connections/page.tsx` and this report.
- Behavior: The QR dialog now shows a live session countdown, expires the UI state with an actionable message, and allows the longer documented pairing window before declaring QR preparation stuck.
- Verification performed: Pending focused frontend lint and mechanical UI detector.
- Deployment/push status: Pending commit, push, and dashboard redeployment.
- Known limitations or failures: WhatsApp still controls whether the handset accepts the QR; the timer reflects PropAI’s pairing session window, not a guarantee of WhatsApp’s exact server-side expiry.
- Independent task-verifier verdict: **PARTIAL** pending verification and deployment.
- Next action: Run lint/detector, commit/push, redeploy `propai-lab:main-app`, and verify the countdown in production.

### Prevent WhatsApp phone-code pairing from waiting on delayed QR events

- Requested outcome: Make WhatsApp pairing reliably produce a QR or phone-number linking code after reset/re-pair, instead of remaining stuck until the UI reports that code generation timed out.
- Files changed: `services/whatsmeow-ingestor/main.go`.
- Behavior: Phone-number pairing now uses the first QR readiness event as a fast path, but falls back after 12 seconds when the WhatsMeow websocket is already connected. It then calls `PairPhone` without waiting for a delayed QR event. Existing disconnect, cancellation, mode-switch, and error handling remain active.
- Verification performed: `gofmt` completed; `GOCACHE=/tmp/propai-go-cache go test ./...` passed in `services/whatsmeow-ingestor`; `git diff --check` passed. Production logs identified the prior failure sequence: code pairing started after reset, no code was issued until the delayed reconnect/QR path, and the UI timed out first.
- Deployment/push status: Scoped commit and push pending. Coolify service needing redeployment: `ingestor` (`egn4dqsw3xxmhb9noorm85do`). No production redeployment was performed in this pass.
- Known limitations or failures: Live handset pairing was not re-tested because the current production ingestor still contains the old waiting behavior until redeployment. WhatsApp may still reject a code for handset/account-side reasons after the code is issued.
- Independent task-verifier verdict: **PARTIAL**.
  - PASS — the delayed-QR blocking path is removed from the code-pairing flow, and the fallback is guarded by websocket connection state.
  - PASS — cancellation, disconnect, pairing-mode changes, and `PairPhone` errors still terminate or retry safely.
  - PASS — ingestor tests, formatting, and diff checks pass.
  - FAIL — production redeployment and a real QR/linking-code smoke test remain outstanding.
- Next action: Commit and push the scoped change, redeploy `ingestor`, then request one fresh linking code without repeatedly resetting the session and confirm the code arrives within the UI timeout.

