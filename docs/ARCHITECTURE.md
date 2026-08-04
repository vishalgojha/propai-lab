# Architecture Rationale

Why PropAI is built the way it is.

## Why WhatsMeow (not WhatsApp Cloud API)?

**WhatsMeow** is a Go library that implements the WhatsApp Web multi-device protocol. It connects as if it were a WhatsApp Web client.

**Why not Cloud API:**
- Cloud API requires Meta business verification (weeks/months).
- Cloud API charges per message for business-initiated conversations.
- Cloud API doesn't support group message capture (only 1:1 and business-initiated).
- WhatsMeow captures the full broker group stream — the core data source.

**Trade-off:** WhatsMeow is unofficial and could break if WhatsApp changes their protocol. We accept this risk because the entire product depends on group message capture, which Cloud API doesn't offer.

**Mitigation:** The ingestor is a isolated service. If the protocol breaks, we can swap the implementation without touching the API or frontend.

## Why Supabase (not raw Postgres)?

Supabase is managed Postgres with a REST API (PostgREST), auth, storage, and a dashboard.

**Why not raw Postgres:**
- Auth integration (JWT-based multi-tenant) is built-in.
- Row-level security as defense-in-depth (though we use service_role key, so RLS is secondary).
- Dashboard for data inspection during development.
- Real-time subscriptions (not currently used, but available for future features).

**Trade-off:** PostgREST's query capabilities are limited for complex aggregations. We work around this with `propai_query_sql` RPC (custom SQL execution).

## Why FastAPI (not Django/Express)?

**Why FastAPI:**
- Python ecosystem: AI/ML libraries (OpenAI, Supabase Python client).
- Async support for concurrent LLM calls and database queries.
- Type hints + Pydantic for automatic validation.
- Performance close to Node.js for I/O-bound work.

**Why not Django:** Too much opinionated structure for a rapidly evolving API. Django ORM adds another abstraction over Supabase's already-abstracted Postgres.

**Why not Express:** Python AI ecosystem is stronger. The backend does heavy AI work (extraction, classification, chat).

## Why Next.js App Router (not Pages Router)?

**Why App Router:**
- React Server Components for SSR without client-side JS overhead.
- `loading.tsx` for instant navigation feedback.
- Built-in ISR (`export const revalidate = 300`).
- Server components can directly call Supabase without API routes.

**Trade-off:** Next.js 16 has breaking changes from training data. We accept this for the SSR benefits.

## Why `propai_query_sql` RPC?

The Supabase Python client's query builder is limited for complex aggregations (GROUP BY, window functions, CTEs). `propai_query_sql` is a Postgres function that accepts raw SQL + params and returns JSONB.

**Why not direct Postgres connection:**
- Supabase's connection pooling (PgBouncer) requires specific connection handling.
- The Python client handles auth, retries, and connection management.
- Keeps all database access through one pattern (PostgREST or RPC).

## Why fire-and-forget usage logging?

`log_ai_usage()` is called from every LLM call site. It inserts into `ai_usage_log` without awaiting the result.

**Why not await:**
- LLM call sites shouldn't be slowed down by logging.
- A logging failure shouldn't break the main flow.
- The cost of a dropped log entry is low (estimation is approximate anyway).

**Trade-off:** Some log entries may be lost under heavy load. Acceptable for a cost estimation tool.

## Why ISR (not SSR on every request)?

The homepage uses `export const revalidate = 300` (5-minute ISR).

**Why not SSR:**
- The homepage queries 6+ database tables on every render.
- With 10k+ listings, the aggregation queries take 1-3 seconds.
- ISR serves cached HTML instantly and regenerates in the background.

**Why not static generation:**
- Data changes daily (new listings, stale listings hidden).
- 5-minute staleness is acceptable for aggregate counters.

## Why no image pipeline (yet)?

WhatsApp media URLs expire after a few days. To show listing photos, we'd need to:
1. Download images when received.
2. Store them (Supabase Storage or S3).
3. Serve them via CDN.
4. Handle WhatsApp's media re-upload flow.

**Why deferred:**
- Adds significant complexity (storage, CDN, cleanup).
- The core value is structured text data, not photos.
- Photos can be added later without schema changes.

## Why tenant_id at the row level (not separate schemas)?

**Why row-level:**
- Supabase's PostgREST supports per-request tenant filtering via `X-Tenant-Id` header.
- Same tables, same queries, same migrations — just filtered by `tenant_id`.
- Easier to add new tenants (no schema duplication).

**Why not separate schemas:**
- Schema-per-tenant doesn't scale with PostgREST (one schema per request).
- Migration management becomes N times harder.
- Row-level filtering is sufficient for the current tenant count (< 10).

## Typed extraction destinations (2026-08-03)

The eight typed tables are the source of truth for extracted market data:

- `residential_sale_listings`, `residential_rent_listings`,
  `commercial_sale_listings`, and `commercial_rent_listings` hold supply.
- `residential_sale_requirements`, `residential_rent_requirements`,
  `commercial_sale_requirements`, and `commercial_rent_requirements` hold
  demand.

Routing is deterministic: demand (`requirement`/`buy`) versus supply, then
`asset_type` (`residential`/`commercial`), then transaction (`sale`/`rent`).
The application writes directly to the selected typed table and preserves the
full LLM payload in `ai_extraction` as evidence. The named read models
`parsed_output_unified`, `listings_unified`, and `requirements_unified` are
live, read-only projections over the typed tables for cross-type reporting and
legacy-shaped reads. They are rebuilt from current typed rows on every query,
not snapshots, and are never write destinations.

The `parsed_output_legacy`, `listings_legacy`, and
`market_requirements_legacy` tables are historical archives from before this
migration. The old names `parsed_output`, `listings`, and
`market_requirements` were temporary compatibility-bridge names and are
deprecated. They are not empty passthrough tables or supported bookmarks. New
code must never write to or query those names, and must use a typed table or
one of the explicitly named read models above. The three `*_legacy` tables
remain queryable historical archives only.
