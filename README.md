# PropAI Local Intelligence Lab

Turn WhatsApp broker groups into structured property intelligence.

## Quick Start

```bash
# Prerequisites: Python 3.10+ and Node.js 20+
pip install -r requirements.txt
cd services/baileys-ingestor && npm install && cd ../..

# Launch API, frontend, and WhatsApp ingestor
./propai connect
```

Starts the PropAI API, starts the frontend, then prints a Baileys QR code in the terminal. Scan it with WhatsApp to connect.

### Already set up?

```bash
./propai connect   # start API/frontend and connect WhatsApp via Baileys
./propai dashboard # open PropAI dashboard
./propai status    # check what's running
```

The `propai` CLI auto-detects running services and starts whatever's missing.

## What it does

```
WhatsApp broker groups →
  Baileys ingestor →
    Webhook → Lab API → SQLite
                             ↓
                       PropAI frontend
```

## URLs

| URL | What |
|-----|------|
| `http://localhost:3000/` | PropAI dashboard |
| `http://localhost:3000/settings` | WhatsApp status/settings |
| `http://localhost:8000/health` | Health check |

## File layout

```
app.py                         FastAPI server (webhook, parser, admin API)
frontend/                      Next.js PropAI UI
services/baileys-ingestor/     WhatsApp connection + live ingestion
config.py                      Environment config
requirements.txt               Python dependencies
schema.sql                     SQLite schema
seed.py                        Test messages with ground truth
admin/index.html               Legacy admin UI
README.md                      This file
```

## How it works

1. **PropAI connects** to your WhatsApp via QR code (custom Baileys ingestor)
2. **Messages flow** from your broker groups into the lab via webhooks
3. **Pipeline parses** each message: extracts type, BHK, price, location
4. **Resolver matches** to known buildings using the evidence engine
5. **Results store** in SQLite — inspectable via the PropAI frontend

## API

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/webhook` | POST | Baileys ingestor forwards WhatsApp messages here |
| `/ingest` | POST | Manual message ingest |
| `/ingest/batch` | POST | Batch seed for evaluation |
| `/api/sources/whatsapp/sync` | POST | Disabled; use chat export import for deterministic history |
| `/api/sources/status` | GET | Sync progress |
| `/api/sync/connection` | GET | WhatsApp connection status |

## Environment

All configurable via env vars — see `lab/config.py`. Key ones:

| Variable | Default | Purpose |
|----------|---------|---------|
| `LAB_HOST` | `0.0.0.0` | Lab API bind |
| `LAB_PORT` | `8000` | Lab API port |
| `PROPAI_WEBHOOK_URL` | `http://localhost:8000/webhook` | Baileys ingestor target |
