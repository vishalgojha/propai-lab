# PropAI

PropAI is a WhatsApp broker intelligence workspace. It ingests broker group messages, parses listings and requirements, and exposes them through the API and web app.

## Architecture

```text
WhatsApp broker groups -> ingestor -> FastAPI -> Supabase
                                          -> Next.js frontend
```

- Hosting: Hetzner Cloud VPS managed via Coolify
- Database: Supabase Postgres
- Frontend: `https://app.propai.live`
- Backend: `https://api.propai.live`

## WhatsApp ingestion

There are two ingestion paths:

1. WhatsApp ingestor - Go-based `whatsmeow` client that connects via QR code from `services/whatsmeow-ingestor/` and forwards broker group messages to the API webhook.
2. WhatsApp Cloud API - official Meta API for broker DMs routed via webhook.

## Production deployment

Deployment is managed by Coolify using [`deploy/coolify/docker-compose.yml`](deploy/coolify/docker-compose.yml).

| Service | Image | Internal URL |
|---------|-------|--------------|
| `api` | FastAPI backend | `http://api:8000` |
| `app` | Next.js frontend | `http://app:3000` |
| `ingestor` | WhatsApp ingestor | `http://ingestor:3001` |

Shared volume `propai-data` persists data across restarts.

## Environment variables

### api service

- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `STATUS_FILE` - `/data/status.json`
- `FRONTEND_URL` - `https://app.propai.live`

### ingestor service

- `PROPAI_WEBHOOK_URL`
- `PROPAI_API_URL`
- `PROPAI_INSTANCE_NAME`
- `AUTH_DIR` - `/data/auth`

### app service

- `LAB_API_BASE_URL` - `http://api:8000`

## Local development

### Prerequisites

- Python 3.10+
- Node.js 20+
- npm for the root helper, pnpm for the frontend app

### Quick start

```bash
./propai install
./propai start
```

Local services run on:

- `http://localhost:8000` - FastAPI backend
- `http://localhost:3000` - Next.js frontend

## File layout

```text
app.py                FastAPI server
frontend/             Next.js UI
config.py             Environment config
storage/               Supabase storage layer
deploy/coolify/        Production deployment config
services/             WhatsApp ingestor
supabase/              Database migrations
```
