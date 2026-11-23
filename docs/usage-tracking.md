# Broker usage tracking (local candidate)

## Owner view

Admin > Broker usage (`/admin/usage`) reads the super-admin-only endpoint
`GET /api/admin/usage/brokers`. It shows every stored workspace, including
workspaces with no recorded searches. A broker can read only their own
workspace summary through `GET /api/usage/summary`.

The view separates:

- App searches: authenticated product search requests that completed.
- Assistant / API: completed assistant searches with unknown initiator.
  This is never presented as confirmed human activity.
- Automated checks: completed API searches explicitly marked automation,
  and standing-search runs. Unknown MCP automation stays in Assistant / API.

The count is rolling seven days, not calendar-week-to-date. Active days are
distinct India-time dates in the last 30 days. The returning stage means the
workspace searched on at least two such days, not necessarily the same user.
Counts are per broker workspace, not per member. Last app search is all-time
since tracking began. Assistant and automation last-at fields cover 30 days.
WhatsApp linked is a saved setup milestone, not current online status.

## Coverage

API:

- Authenticated market-items, market and raw searches.
- Authenticated chat requests with completed listing/requirement or direct
  group-evidence searches. One request produces at most one event, even if
  both group evidence and listing helpers succeed. Helpers outside an
  authenticated app-chat request do not record app usage.
- Completed model-selected chat turns whose activity includes a successful
  market, listing, requirement, opportunity, group/WhatsApp evidence, raw
  extraction or client-to-listing search. Multiple tools in one such turn
  produce one event, not one per nested query.
- External raw-message search, listing search, requirements and matches.
- Standing-search runs, marked automation.
- Property cross-search REST and its stateless MCP adapter.

The unauthenticated legacy `/api/search` is deliberately not tracked. Plain
chat, failed/rejected searches, degraded indexed-search fallback responses,
contact reveals, writes, auth checks and setup actions do not count as searches.
WhatsApp self-chat reuse of these helpers is excluded, not mislabeled app use.
The app count is a server-completed authenticated request count, not proof a
human initiated it or read the result. Repeated HTTP requests count separately;
this is not a count of distinct real-world requirements.
This is a search-usage measure, not a complete page-view or sign-in audit.

MCP:

- Legacy MCP successful data-search handlers and market resources, using the
  same substantive-data success boundary as the existing trial recorder.
The reconciled current-main MCP tree does not contain the earlier separate
raw-MCP or broker-market modules. Their candidate-only instrumentation is not
included. Existing current-main raw search tools are instrumented. API
broker-market routes are included. No absent feature is added for telemetry.

MCP writes directly to the usage table because its Supabase reads bypass
API routes. Its usage origin is always assistant_unlabeled. The recorder
accepts only a workspace ID, never a user ID or API-key ID. Existing auth
still verifies a principal before allowing access; that identity does not
flow into the usage table.

## Data and access

New table: `broker_usage_events`. Stored fields: generated event ID, workspace
(tenant) ID, surface, fixed search action, origin and server timestamp. There
are no user-ID or API-key-ID columns, per-member rows or per-member breakdowns. No query text, filters, message bodies, returned results or tool
activity summaries are added to this table. Existing analytics/logging are
outside this change; this is not a claim that no other product logs contain
search inputs.

RLS policy permits service_role only. No new browser-side DB access.
Migration adds the table, one workspace/time index, RLS policy and grants, and does not
alter existing tables or views. Apply only with separate schema/deployment
authority. This reconciled candidate has not yet been pushed, migrated or deployed.

API inserts use a bounded background queue so telemetry cannot hold up the
search event loop. A full queue, failed write or process shutdown can lose
counts. MCP inserts are also best effort. The view is usage telemetry, not
billing-grade accounting. Counts start after this tracking is deployed; zero
recorded usage is not proof of no earlier usage.

Summary reads page below the provider row cap and expose `partial=true` at
the 100,000-record safety ceiling. Errors do not become an all-zero dashboard.
The admin frontend clears stale data on refresh failures.

## Local verification

Python: `python -m pytest tests/test_usage_tracking.py -q`.
MCP: build and tests from `apps/mcp`, including real in-memory MCP transport.
Network-isolated HTTP tests need loopback enabled inside the namespace.

Frontend visual fixture: build with fixture auth configuration, then run
`frontend/scripts/usage-visual-acceptance.mjs`. Set PLAYWRIGHT_MODULE to an
installed playwright-core module, CHROME_PATH to Chrome, and EVIDENCE_DIR to
an output directory. The script starts/stops its own local server, uses no
real credentials, intercepts API replies and checks desktop/mobile layout,
filtering, error recovery and empty states. It is not live end-to-end proof.

The global frontend typecheck has pre-existing errors elsewhere. The production
build passes; changed usage-page/admin-link files have no reported type errors.
All acceptance here is owner-reported, not an independent review or release
approval.


### Real local database rehearsal (v3)

`tests/usage_db_rehearsal.py` uses disposable PGlite PostgreSQL behind the real
PostgREST executable and the actual production SupabaseStorage REST client.
It mounts the real search/usage routers in an isolated FastAPI application,
verifies synthetic signed JWTs through the real auth dependency, reads a
synthetic listing, lets the real background queue insert a usage row, and
reads it through the real admin and workspace summaries. It also adds 1,201
synthetic assistant events to exercise real provider pagination, kept separate
from the single app event. 401/403 access checks use the actual JWT/admin paths.
No database methods, usage recorder, search result or summary are mocked.

With a built frontend whose LAB_API_BASE_URL is http://127.0.0.1:8138, the
companion browser script checks the actual admin page through Next's native
API rewrite. That usage response is not intercepted or replaced. Supabase's
browser session-validation endpoint and unrelated app-shell requests are
fixtures. The rehearsal does not run the whole production application,
production schemas, external auth provider, deployment or a live broker.
Group-chat and self-chat regressions separately exercise their actual Python
entrypoints with fixture search/model data; those are not claimed as the
same real-DB rehearsal. No proof here establishes deployed behavior.

Run inside an isolated network namespace with only loopback enabled, setting
USAGE_REHEARSAL_ISOLATED=1, POSTGREST_BIN, PGLITE_MODULE,
PGLITE_SOCKET_MODULE, EVIDENCE_DIR, and optionally USAGE_UI_DIR and
PLAYWRIGHT_MODULE. The module variables are absolute module paths. Start with
`python tests/usage_db_rehearsal.py`; all child servers are stopped on exit.
The temporary /rest/v1 proxy strips only the URL prefix and fixture database
auth headers. It does not fabricate query results. PostgreSQL/PostgREST use
service_role in this local fixture; browser-facing auth still uses real JWT
verification and real stored admin/membership checks.

This rehearsal caught and fixed a real client-contract mismatch: the custom
REST query builder supports limit/offset, not range. Summary event pages now
use a single unique-id ordering with limit/offset, instead of relying on an
unsupported method or multiple repeated PostgREST order parameters.


### Minimal identity scope (v4 successor)

The approved offer is workspace-level setup, last search, weekly searches,
return days and separate assistant/automation traffic. Workspace identity,
event time, search action and source/origin are enough for these metrics.
Optional authenticated-user/API-key identity and a per-user breakdown were
unnecessary additions in v3. V3 remains preserved locally for provenance;
v4 removes those additions rather than asking to widen the offer.

Existing authentication, membership and super-admin checks still use their
normal identities. The in-memory chat collector uses the authenticated user
only to isolate a request, then resets. That is transient control state,
not a usage field. Neither API nor MCP usage recorder accepts user/key identity.
This work has not applied any candidate migration. First release assumes
no earlier usage schema was applied; verify that live before applying. If an
earlier candidate table exists, stop for separately approved reconciliation,
rather than treating an edited migration file as an applied-schema repair.
This change does not alter pre-existing authentication/audit logs or their
own policies, and is not a claim that the whole product stores no user IDs.


### Current-main integration, 23 November 2026

Usage-only deltas were ported onto c778ac2056988cf822cc7baf3437b83d23358965.
No old branch was merged. API source-specific extraction controls and authorized
business intake remain unchanged. MCP and app frontend were observed running
464a385c before this release; their existing source is ancestral to current main.

Current checks: 83 API usage and extraction-control tests passed; 62 current-main
MCP tests passed; frontend build passed with synthetic auth configuration;
9 migration checks passed in disposable PGlite; real local PostgreSQL/PostgREST
JWT/search/queue/summary rehearsal passed. Fixture UI passed at1280/390/320 and
desktop/mobile screenshots were inspected. These are local checks, not live E2E.

Live preflight SELECT to_regclass('public.broker_usage_events') returned NULL on
23 November at10:55IST. Recheck immediately before applying the migration. If a
table appears or differs, stop, do not reconcile/delete it silently. No production
schema mutation occurred during this preflight.
