<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# PropAI — Agent Entry Point

This is the index for all PropAI documentation. Read in this order before making changes.

## Read first (permanent knowledge)

| Document | Purpose |
|----------|---------|
| [`docs/PRODUCT.md`](docs/PRODUCT.md) | Product principles, non-negotiables, success metric |
| [`docs/DATA_QUALITY.md`](docs/DATA_QUALITY.md) | Extraction rules, dedup logic, freshness, what we never do |
| [`docs/SEO.md`](docs/SEO.md) | Crawlability contract, rendering rules, sitemap, structured data |
| [`docs/UX.md`](docs/UX.md) | UI commandments — counters, empty states, navigation, forms |
| [`docs/GLOSSARY.md`](docs/GLOSSARY.md) | Domain terms (listing, requirement, micro-market, inventory, etc.) |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Why WhatsMeow, why Supabase, why FastAPI, design trade-offs |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | Decision log — what was decided, why, and the outcome |
| [`docs/PROPai_DATA_QUALITY_AUDIT_2026-08-16.md`](docs/PROPai_DATA_QUALITY_AUDIT_2026-08-16.md) | Mandatory current audit: identity, dedupe, extraction, ingestion, enrichment, and semantic failure modes |
| [`architecture.md`](architecture.md) | Living system map, invariants, landmines, verification playbook, and decisions |

## Hard rules (never violate)

1. **Never fabricate inventory.** Every listing traces to a real WhatsApp message.
2. **Never show fake counters.** All numbers on the public site come from live database queries.
3. **Never show placeholder text to crawlers.** No "Updating", "Loading...", "N/A" on public pages.
4. **Never replace deterministic extraction with LLM** unless explicitly requested.
5. **Never reduce crawlability.** All public pages must be server-side rendered with real data.
6. **Never expose phone numbers in HTML.** Use server-side resolution via `/api/contact-broker/[id]`.
7. **Never auto-merge listings.** Same building ≠ same flat. Different floors = different listings.
8. **Never modify production search logic** without reading `docs/DATA_QUALITY.md` first.
9. **Never commit secrets, API keys, or phone numbers** to the repository.
10. **Stage only my hunks.** `app.py` and `storage/supabase.py` carry pre-existing dirty work.
11. **Keep architecture living.** Any change to a data-model invariant, tenant boundary, pipeline stage, matching/consent behavior, or a logged landmine must update root [`architecture.md`](architecture.md) in the same commit as the code and tests. Regenerated Mermaid artifacts under `docs/architecture/generated/` are never hand-edited.

## File layout (what lives where)

```text
app.py                          FastAPI backend (Python)
apps/www/                       Next.js public site (www.propai.live)
frontend/                       Next.js internal dashboard (app.propai.live)
storage/                        Supabase storage layer
services/whatsmeow-ingestor/    WhatsApp ingestor (Go)
supabase/migrations/            Database migrations
docs/                           Product documentation (this index)
deploy/coolify/                 Production deployment config
```

## Coolify Infrastructure

Production is managed in the Coolify `production` environment on the PropAI
Labs project, running on the Hetzner VPS. The inventory below was cross-checked
against the read-only Coolify wiring audit from 2026-08-27. “Internal” means the
resource has no public URL and is reached over the Coolify/Docker network.
For source paths, commands, and the distinction between Coolify resources and
the checked-in compose services, see [`WIRING_AUDIT.md`](WIRING_AUDIT.md) and
[`architecture.md`](architecture.md). Do not treat the old `app` compose name as
the Coolify resource name `propai-lab:main-app`.

| Coolify application | URL | Server | Purpose |
|---|---|---|---|
| `activepieces` | `https://automations.propai.live` | Hetzner VPS via Coolify | Retired workflow UI; do not use for Gmail ingestion |
| `api` | `https://api.propai.live` | Hetzner VPS via Coolify | FastAPI backend, API routes, webhooks, and server-side data access |
| `extraction-worker` | Internal; no public URL | Hetzner VPS via Coolify | Processes WhatsApp messages into source-grounded typed listings and requirements |
| `gmail-ingestor` | Internal; no public URL | Hetzner VPS via Coolify | Lightweight Gmail label poller that forwards email evidence to the API |
| `ingestor` | Internal; no public URL | Hetzner VPS via Coolify | WhatsMeow WhatsApp connection and raw message ingestion |
| `matcher` | Internal; no public URL | Hetzner VPS via Coolify | Requirement-to-listing matching worker |
| `mcp` | Internal/private; no public URL recorded | Hetzner VPS via Coolify | PropAI MCP server and scoped data/tools interface |
| `propai-lab:enrichment` | Internal; no public URL | Hetzner VPS via Coolify | Building/entity enrichment worker |
| `propai-lab:main` | `https://www.propai.live` | Hetzner VPS via Coolify | Public SSR website and search |
| `propai-lab:main-app` | `https://app.propai.live` | Hetzner VPS via Coolify | Authenticated internal dashboard |
| `propai-lab:openclaw` | Internal: `http://openclaw:18789` | Hetzner VPS via Coolify | Isolated OpenClaw gateway for approved operations-agent work |
| `semantic-embedding-worker` | Internal; no public URL | Hetzner VPS via Coolify | Generates and stores semantic embeddings |
| `social-flow:main` | Private/internal; URL not recorded in repo | Hetzner VPS via Coolify | External `vishalgojha/social-flow` SDK service for Ads Studio |
| `tenant-boundary-repair-worker` | Internal; no public URL | Hetzner VPS via Coolify | Approval-gated tenant-boundary repair queue |

The Coolify API project and environment identifiers, plus the last verified
resource/source mapping, are intentionally maintained in `WIRING_AUDIT.md`
rather than duplicated here. Public domains and internal URLs are not secrets;
Coolify tokens and all deployment credentials are secrets and must never be
committed to this repository.
