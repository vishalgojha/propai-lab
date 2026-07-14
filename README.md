<<<<<<< HEAD
# PropAI

WhatsApp broker group intelligence — scrape, parse, and surface property listings from WhatsApp.

## Architecture

```
WhatsApp broker groups ──► ingestor ──► FastAPI ──► Supabase
                                                   ──► Next.js frontend
```

- **Hosting**: Hetzner Cloud VPS (16 vCPU, 14 GB RAM), managed via Coolify
- **Database**: Supabase (Postgres) — primary storage for all messages, parsed observations, listings, and user data
- **Frontend**: Next.js at `https://app.propai.live`
- **Backend**: FastAPI at `https://api.propai.live`

### WhatsApp ingestion

Two ingestion paths:

1. **WhatsApp ingestor** — Go-based (whatsmeow). Connects as a WhatsApp client via QR code from `services/whatsmeow-ingestor/`. Captures group messages and forwards them to the API webhook. Auth state persists on shared volume.
2. **WhatsApp Cloud API** — official Meta API for DM-based broker interactions (incoming DMs routed via webhook).

## Production deployment

Deployment is handled by Coolify using `deploy/coolify/docker-compose.yml`.

| Service | Image | Internal URL |
|---------|-------|-------------|
| `api` | FastAPI backend | `http://api:8000` |
| `app` | Next.js frontend | `http://app:3000` |
| `ingestor` | WhatsApp ingestor (whatsmeow Go) | `http://ingestor:3001` |

Shared volume `propai-data` persists data across restarts.

### Domains

| Domain | Target |
|--------|--------|
| `https://app.propai.live` | Next.js frontend |
| `https://api.propai.live` | FastAPI backend |

### Environment variables (production)

**api service:**
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` — Supabase credentials
- `STATUS_FILE` — path to ingestor status file (default: `/data/status.json`)
- `FRONTEND_URL` — frontend domain for redirects (default: `https://app.propai.live`)

**ingestor service:**
- `PROPAI_WEBHOOK_URL`, `PROPAI_API_URL` — API service address (`http://api:8000`)
- `PROPAI_INSTANCE_NAME` — instance label for multi-tenant (default: `propai-whatsmeow`)
- `AUTH_DIR` — WhatsApp session directory (shared volume, default: `/data/auth`)

**app service:**
- `LAB_API_BASE_URL=http://api:8000` — internal Docker DNS for API proxy

## Local development

### Prerequisites

- Python 3.10+
- Node.js 20+
- npm

### Quick start

```bash
./propai install    # Install Python + frontend deps
./propai connect    # Start API (port 8000), frontend (port 3000)
```

Local services run on:
- `http://localhost:8000` — FastAPI backend
- `http://localhost:3000` — Next.js frontend

### Env vars with local-dev defaults

| Variable | Local default | Production |
|----------|--------------|------------|
| `LAB_API_BASE_URL` | `http://localhost:8000` | `http://api:8000` |
| `SUPABASE_URL` | *(must be set)* | set via Coolify |

## File layout

```
app.py                         FastAPI server
frontend/                      Next.js UI
config.py                      Environment config
storage/                       Supabase storage layer
deploy/coolify/                Production deployment config
```
=======
This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
>>>>>>> d6d6293 (Fix frontend build and layout wiring)
# force rebuild
