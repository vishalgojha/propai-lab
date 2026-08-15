# Coolify + Hetzner deployment

PropAI runs on a Hetzner Cloud VPS managed by Coolify.

## Services

| Service | Container | Exposes |
|---------|-----------|---------|
| `api` | FastAPI backend (`uvicorn app:app --port 8000`) | port 8000 |
| `app` | Next.js frontend | port 3000 |
| `ingestor` | WhatsApp ingestor (whatsmeow Go) | port 3001 (internal) |

WhatsApp ingestor connects as a WhatsApp client via pairing code, captures group messages, and forwards them to the API webhook. Auth state persists in `/data/auth/` on the shared volume.

## Persistent data

The `propai-data` shared volume is mounted at `/data` on the `api` service.

## Environment variables

Set these on each service in Coolify:

### api

| Variable | Value |
|----------|-------|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `PROPAI_INTERNAL_TOKEN` | Shared random secret for API ↔ WhatsMeow internal calls (set the same value on API, ingestor, and alert job) |
| `DOUBLEWORD_API_URL` | `https://api.doubleword.ai/v1` |
| `DOUBLEWORD_API_KEY` | Active Doubleword inference key used by AI Chat and other configured routes |
| `DOUBLEWORD_MODEL` | Exact model ID enabled for this key (required when Doubleword is enabled; e.g. the configured DeepSeek model) |
| `HERMES_API_URL` | Optional internal Hermes API endpoint, normally `http://hermes:8642/v1`; leave empty to disable the Super Admin agent |
| `HERMES_API_KEY` | Optional server-side bearer key for the isolated Hermes API; never expose this to the frontend |
| `HERMES_AGENT_MODEL` | Hermes profile/model alias used by the Super Admin console; defaults to `hermes-admin` |
| `NVIDIA_MODEL`, `GROQ_MODEL`, `GEMINI_MODEL`, `CEREBRAS_MODEL`, `GRID_MODEL` | Exact model ID for each enabled provider; do not set a key without its matching model variable |
| `EXTRACTION_MODEL` | Optional. Pin the model used first for extraction (e.g. `llama-3.1-8b-instant`). Extraction prefers small/fast models over premium ones and keeps them only as a costlier fallback. |
| `EXTRACTION_DOUBLEWORD_API_KEY` | Optional extraction-only Doubleword inference key for controlled backlog draining. |
| `EXTRACTION_DOUBLEWORD_MODEL` | Exact model ID enabled for the extraction-only Doubleword key. Required with `EXTRACTION_DOUBLEWORD_API_KEY`. |
| `EXTRACTION_DOUBLEWORD_BASE_URL` | Optional; defaults to `https://api.doubleword.ai/v1`. Thinking is disabled for this scoped provider. |
| `EXTRACTION_PROVIDER_TIMEOUT_SECONDS` | Optional extraction provider request timeout; defaults to `180` seconds and is clamped to a minimum of `30`. |
| `DOUBLEWORD_EMBEDDING_MODEL` | Exact embedding model ID, if the MCP embedding service is enabled |
| `FRONTEND_URL` | `https://app.propai.live` |
| `GOOGLE_MAPS_API_KEY` / `GOOGLE_PLACES_API_KEY` | Server-side Google key used to cache building coordinates, formatted addresses, and Plus Codes. The backend accepts either name; `GOOGLE_MAPS_API_KEY` matches the existing frontend configuration. |
| `STATUS_FILE` | `/data/status.json` |
| `LAB_HOST` | `0.0.0.0` |
| `LAB_PORT` | `8000` |

### ingestor

| Variable | Value |
|----------|-------|
| `PROPAI_WEBHOOK_URL` | `http://api:8000/webhook` |
| `PROPAI_API_URL` | `http://api:8000` |
| `PROPAI_INSTANCE_NAME` | `propai-whatsmeow` |
| `SUPABASE_SERVICE_KEY` | Same service role key used by the API, for authenticated internal agent calls |
| `PROPAI_INTERNAL_TOKEN` | Same shared internal service secret used by the API |
| `DATABASE_URL` | Active Supabase Postgres connection string from the Supabase Connect panel |
| `AUTH_DIR` | `/data/auth` |
| `STATUS_FILE` | `/data/status.json` |

### app (next.config.ts build args)

| Variable | Value |
|----------|-------|
| `LAB_API_BASE_URL` | `http://api:8000` (internal Docker DNS) |
| `NODE_ENV` | `production` |
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |

The standalone public `www.propai.live` Coolify application uses the same
server-side data client as the dashboard. Configure these variables on that
application as runtime environment variables (not only build arguments):

| Variable | Value |
|----------|-------|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key; preferred for server-side reads |
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key; safe read-only fallback for public views |

The public site falls back to the anon key when `SUPABASE_SERVICE_KEY` is not
present, but the service key should still be configured so all public data
queries behave consistently with the dashboard.

The frontend rewrites `/api/*` to `http://api:8000/api/*` inside the Docker network.

## Domains

Configure these in Coolify under "Domains" for each service:

| Domain | Service |
|--------|---------|
| `app.propai.live` | `app` |
| `api.propai.live` | `api` |

## Coolify notes

- Coolify manages the `docker-compose.yml` in this directory
- Let's Encrypt certificates are auto-renewed for custom domains
- No raw Docker Compose commands needed — use Coolify's UI or API
