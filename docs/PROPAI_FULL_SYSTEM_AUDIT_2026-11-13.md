# PropAI full site and app audit — 2026-11-13

## Scope and verdict

This is a repository and deployment-wiring audit of the public site, authenticated
app, API, MCP server, Instinct integration, source-visibility pipeline, billing,
workers, and Coolify configuration. The live authenticated UI could not be
clicked through because the available browser runtime was unavailable. No
runtime code or production data was changed by this audit.

Overall verdict: **PARTIAL / not ready to call coherent end-to-end**. The main
security primitives exist, but the product contract is split across three
different models: tenant-private workspace inventory, cross-tenant shared-market
inventory, and an anonymous public website. The implementation does not yet
make those models explicit and consistent at every consumer.

## Confirmed findings

### P0 — Visibility model is unresolved at the consumer boundary

The current product decision is: DMs and unchecked groups are private; checked
ingestion groups can produce shared-market inventory. The API/public projection
gate implements part of that model (`organization_group_connections.public_market_source`,
`visibility='shared_market'`, and the connection allowlist in
`supabase/migrations/20261113110000_instinct_connection_publication_gate.sql`).

However, the public site still reads anonymous `listings_unified_public` routes,
while MCP's functions named `searchPublicListings` query tenant-filtered
`listings_unified` and tenant raw messages (`apps/mcp/src/data.ts:666-730`).
Thus MCP `source_mode=public` is not the shared-market projection; it is another
view of the caller's tenant. Decide and document whether shared-market data is
anonymous-web public, authorized-tenant public, or both, then give each consumer
one named projection and one contact policy.

### P1 — Instinct and MCP ownership is split and misleading

The Account page exposes separate Instinct and MCP tabs, but token creation,
rotation, write permissions, DM consent, and setup tasks all live in the MCP
component (`frontend/src/app/account/page.tsx:7-22`,
`frontend/src/app/workspace/mcp/page.tsx:35-186`). The Instinct component only
copies a prompt and links to Instinct (`frontend/src/app/workspace/instinct/page.tsx:6-98`).
This explains why a user sees the Instinct token in the MCP tab. It is a product
IA discrepancy, not merely a missing label.

There are also two token issuers:

- normal key creation explicitly stores read scopes and optional write scopes
  (`routers/external_agent.py:380-422`);
- the setup-agent issuer inserts no explicit scopes and relies on database
  defaults (`routers/integrations_agent.py:42-60`).

Additionally, `_key_row()` adds all tool-read scopes dynamically to every active
key (`routers/external_agent.py:98-104`), although the Instinct prompt says the
`/health` scopes are authoritative (`frontend/src/app/workspace/instinct/page.tsx:20-23`).
Scope issuance must be centralized, persisted, and enforced from the persisted
set; consent should only add/remove the specific DM capability.

### P1 — Contact data is still exposed inside MCP UI/tool payloads

The MCP listing type carries phone fields (`apps/mcp/src/types.ts:29-31`), the
listing-card UI receives `broker_phone` and passes it to `contact_call`
(`apps/mcp/src/uiResources.ts:117-124`), and `contact_call` returns phone numbers
directly (`apps/mcp/src/tools/contact.ts:41-70`). This may be acceptable for an
authorized workspace contact action, but it conflicts with the repository rule
that phones do not enter arbitrary HTML or unrestricted shared projections.
The safe contract is an opaque listing/contact action resolved server-side,
with an audited response, not a phone-bearing card payload or caller-supplied
phone fallback.

### P1 — DM privacy and extraction rules disagree across layers

The current architecture/product wording says DMs are private, but the
architecture decision at `architecture.md:1177-1193` allows incoming live DMs to
produce typed listings or requirements. The external-agent API correctly gates
DM reads behind owner consent, but typed extraction/publication must also prove
that DM-derived rows cannot become `shared_market` or anonymous public rows.
This needs a database-level invariant and a regression test, not only UI copy.

### P1 — Billing is copy, not a connected commercial path

The billing UI displays MCP at ₹799 and self-chat at ₹1,999 with trial language
(`frontend/src/app/profile/billing/page.tsx:29-46`), but it has no plan selection,
checkout, subscription state, invoice state, or payment confirmation. The
repository also contains an untracked legacy `routers/payments.py` whose route is
not included by `app.py` and references missing imports (`os` and
`get_current_user`). Existing entitlement/trial logic is separately documented
as fail-open when billing state is unavailable. Treat billing as unimplemented
until a single provider, plan IDs, webhook state machine, and enforcement tests
are connected.

### P1 — Public-site SEO contract is internally contradictory

`apps/www` contains live SSR discovery pages and queries public projections, but
the root metadata and robots route set `noindex, nofollow` and disallow `/`
(`apps/www/src/app/layout.tsx:8-32`, `apps/www/src/app/robots.ts:1-5`). The sitemap
function currently returns `[]` before its real generation logic
(`apps/www/src/app/sitemap.ts:24-28`). This is coherent only if the public site is
deliberately a non-indexable product surface. It is not coherent with copy that
describes public discovery or an SEO-driven marketplace. Choose one mode and
remove the dead/contradictory path.

### P1 — Publication migration contains environment-specific data

The connection publication migration inserts a hard-coded tenant UUID and
connection ID (`supabase/migrations/20261113110000_instinct_connection_publication_gate.sql:43-45`).
That is unsafe as a reusable migration and makes deployment state depend on one
environment's identifiers. The allowlist must be provisioned through an explicit,
audited operator action or a stable environment configuration, not a migration
literal.

### P2 — Documentation is materially contradictory

`docs/PRODUCT.md:7-14` still says no shared/public market exists, while the
following section and the living architecture describe a hybrid shared-market
boundary. Later product sections still describe public discovery and owner
routing. `architecture.md:16-37`, `:64-83`, and `:1177-1193` likewise contain
different visibility eras. This makes future implementation and agent changes
unsafe because both interpretations appear authoritative.

### P2 — Operational readiness is incomplete

The read-only Coolify audit showed health checks disabled for API, app, public
site, and MCP, so several services report `running:unknown` rather than healthy.
At audit time `matcher`, `propai-lab:enrichment`, `public-collections-worker`,
`tenant-boundary-repair-worker`, `google-drive-sync`, and `propai-lab:openclaw`
were unhealthy/exited, while the public-site deployment was in progress. The
frontend app also watches only `frontend/src/app/admin/ops/page.tsx`, so normal
frontend changes may not trigger a deployment. Add health endpoints/checks,
correct watch paths, and define which unhealthy workers are required for the
paid speed-to-action promise.

## Verification evidence

- `apps/mcp`: TypeScript build and all 5 test suites passed.
- `apps/www`: webpack production build passed, including TypeScript and static
  page generation.
- `frontend`: webpack compilation passed, but the production build failed during
  static-page generation with a worker exit; the default Turbopack build also
  hit an environment `Operation not permitted` process-binding failure.
- Python syntax compilation passed for the inspected API routers with
  `python3 -m py_compile`; the payments route remains structurally disconnected
  and runtime-import unsafe.
- Live authenticated browser verification was unavailable, so token storage,
  consent toggles, MCP OAuth, and post-login routing remain unverified in a real
  session.

## Recommended remediation order

1. Ratify one visibility matrix: DM, unchecked group, checked group, private
   CRM, shared tenant projection, and anonymous web projection.
2. Create explicit shared-market and workspace-private read APIs; remove the
   misleading MCP `public` name and test cross-tenant visibility plus raw/phone
   denial.
3. Centralize token issuance and scope enforcement; make Instinct the owner of
   Instinct credentials and MCP the owner of OAuth/MCP configuration, or merge
   them into one integrations surface.
4. Replace phone-bearing MCP cards and caller-supplied contact fallbacks with
   opaque, audited server-side contact actions.
5. Resolve DM extraction visibility at the schema/RLS boundary.
6. Connect billing entitlements to a real payment/webhook state machine, then
   enforce speed/freshness/capacity benefits rather than contact access.
7. Reconcile product/architecture/SEO docs and add service health checks before
   claiming the full site/app is production-ready.
