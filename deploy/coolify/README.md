# Coolify + Hetzner deployment

PropAI runs on a Hetzner Cloud VPS managed by Coolify.

## Services

| Service | Container | Exposes |
|---------|-----------|---------|
| `api` | FastAPI backend (`uvicorn app:app --port 8000`) | port 8000 |
| `app` | Next.js frontend | port 3000 |
| `ingestor` | WhatsApp ingestor (whatsmeow Go) | port 3001 (internal) |

WhatsApp ingestor connects as a WhatsApp client via QR code, captures group messages, and forwards them to the API webhook. Auth state persists in `/data/auth/` on the shared volume.

## Persistent data

The `propai-data` shared volume is mounted at `/data` on the `api` service.

## Environment variables

Set these on each service in Coolify:

### api

| Variable | Value |
|----------|-------|
| `SUPABASE_URL` | Your Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `FRONTEND_URL` | `https://app.propai.live` |
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
