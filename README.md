# PropAI Local Intelligence Lab

Turn WhatsApp broker groups into structured property intelligence.

## Quick Start

```bash
# Prerequisites: Docker Desktop + Python 3.10+
pip install -r lab/requirements.txt

# Launch everything — containers, API, and onboarding page
propai waba
```

Opens `http://localhost:8000/connect` — scan the QR code with WhatsApp to connect.

### Already set up?

```bash
propai waba        # start + open onboarding
propai lab         # open admin dashboard
propai status      # check what's running
```

The `propai` CLI auto-detects running services and starts whatever's missing.

## What it does

```
WhatsApp broker groups →
  Evolution API (Docker container) →
    Webhook → Lab API → SQLite
                             ↓
                       Admin UI + Onboarding
```

## URLs

| URL | What |
|-----|------|
| `http://localhost:8000/connect` | WhatsApp QR onboarding |
| `http://localhost:8000/` | Admin dashboard |
| `http://localhost:8000/health` | Health check |
| `http://localhost:8080/manager` | Evolution API manager |

## File layout

```
lab/
├── app.py              FastAPI server (webhook, admin API, onboarding)
├── config.py           Environment config
├── docker-compose.yml  Evolution API + PostgreSQL
├── requirements.txt    Python dependencies
├── start.sh            Legacy shell entry point
├── schema.sql          SQLite schema
├── seed.py             Test messages with ground truth
├── admin/index.html    Admin UI (zero-dependency SPA)
├── sources/            Source sync engine (WhatsApp, etc.)
└── README.md           This file
```

## How it works

1. **PropAI connects** to your WhatsApp via QR code (Evolution API + Baileys)
2. **Messages flow** from your broker groups into the lab via webhooks
3. **Pipeline parses** each message: extracts type, BHK, price, location
4. **Resolver matches** to known buildings using the evidence engine
5. **Results store** in SQLite — inspectable via the admin UI

## API

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/webhook` | POST | Evolution API forwards WhatsApp messages here |
| `/ingest` | POST | Manual message ingest |
| `/ingest/batch` | POST | Batch seed for evaluation |
| `/api/sources/whatsapp/sync` | POST | Trigger historical sync for a group |
| `/api/sources/status` | GET | Sync progress |
| `/api/sync/connection` | GET | WhatsApp connection status |

## Environment

All configurable via env vars — see `lab/config.py`. Key ones:

| Variable | Default | Purpose |
|----------|---------|---------|
| `LAB_HOST` | `0.0.0.0` | Lab API bind |
| `LAB_PORT` | `8000` | Lab API port |
| `EVOLUTION_API_URL` | `http://localhost:8080` | Evolution API address |
| `AUTHENTICATION_API_KEY` | auto-generated | API key for Evolution API |
