# PropAI Local Intelligence Lab

Turn WhatsApp broker groups into structured property intelligence.

## System Requirements

Before running PropAI for the first time, make sure you have:

- Python 3.10 or newer
- Node.js 20 or newer
- `npm`
- A terminal with Bash support
- A WhatsApp mobile app on the phone you will link
- Internet access for WhatsApp and Meta services

Recommended on first run:

- `git`
- `curl`
- `uuidgen` or Python available to generate an API key

## First Run

From a fresh checkout:

```bash
./propai install
./propai qr
```

What happens:

1. `propai install` installs Python, frontend, and Baileys dependencies.
2. `propai qr` starts the local services if needed.
3. If WhatsApp is not connected yet, PropAI shows the QR flow in the terminal.
4. If WhatsApp is already connected, it prints the live connection status and exits.

## Quick Start

### Run from this checkout

```bash
./propai install
./propai qr
```

### Common commands

```bash
./propai qr         # Show terminal QR / connection status
./propai connect    # Start the API, frontend, and Baileys ingestor
./propai dashboard  # Open the PropAI dashboard
./propai status     # Check what is running
./propai doctor     # Run health checks
```

`propai qr` is the command you want when pairing WhatsApp.  
`propai connect` is the service launcher and remains available for compatibility.

## What It Does

```text
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
| `http://localhost:3000/settings` | WhatsApp status / settings |
| `http://localhost:3000/connections` | Connection Center |
| `http://localhost:8000/health` | Health check |

## File Layout

```text
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

## How It Works

1. PropAI connects to WhatsApp through the terminal QR flow.
2. Messages flow from broker groups into the lab via the Baileys ingestor.
3. The pipeline parses each message: type, BHK, price, location.
4. The resolver matches messages to known buildings using the evidence engine.
5. Results are stored in SQLite and surfaced in the PropAI frontend.

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

All configuration lives in env vars. See `lab/config.py` for the full list.

Key variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `LAB_HOST` | `0.0.0.0` | Lab API bind host |
| `LAB_PORT` | `8000` | Lab API port |
| `PROPAI_WEBHOOK_URL` | `http://localhost:8000/webhook` | Baileys ingestor target |
| `ENABLE_AI_PROMO` | `false` | Enable promotion copy generation |
| `ENABLE_META_PUBLISHING` | `false` | Expose optional Meta publishing controls |

## Notes

- `propai qr` is the safest first command if you are not sure whether WhatsApp is already connected.
- The terminal QR flow is now the primary pairing path.
- The browser UI reads the live Baileys connection status from the local status file and backend.
