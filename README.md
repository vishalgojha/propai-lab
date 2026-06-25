# PropAI Lab

Turn WhatsApp broker groups into structured property intelligence.

## Quick Start

```bash
# Prerequisites: Docker Desktop + Python 3.10+
pip install -r requirements.txt

# Launch everything
./propai waba
```

Scans your QR code, connects your WhatsApp, and starts importing property listings from your broker groups.

## Commands

| Command | What it does |
|---------|-------------|
| `./propai waba` | Start services + open QR onboarding |
| `./propai lab` | Open admin dashboard |
| `./propai status` | Check running services |

On first run, `propai` auto-generates an API key, starts Docker containers (Evolution API + PostgreSQL), creates your WhatsApp instance, and opens the onboarding page.

## URLs

| URL | Purpose |
|-----|---------|
| `http://localhost:8000/connect` | QR code onboarding |
| `http://localhost:8000/` | Admin dashboard |
| `http://localhost:8080/manager` | Evolution API manager |

## How it works

1. **Connect** your WhatsApp by scanning a QR code
2. **Messages** from your broker groups arrive via webhook
3. **Pipeline** extracts: listing type, BHK, price, location, furnishing
4. **Resolver** matches each listing to known buildings
5. **Results** stored in SQLite, browsable in the admin UI

## Requirements

- Docker Desktop (24+) or Docker Engine
- Python 3.10+
- macOS, Linux, or Windows (WSL2)

## Files

```
app.py              FastAPI server
config.py           Environment config
docker-compose.yml  Evolution API + PostgreSQL
requirements.txt    Python dependencies
schema.sql          Database schema
seed.py             Test data
admin/index.html    Admin UI
sources/            Sync engine
```

## License

MIT
