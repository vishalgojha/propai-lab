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

## Session state (ephemeral)

For current session state, pending work, and deployment notes, see `CLAUDE.md`.
For permanent product knowledge, see `docs/`.
