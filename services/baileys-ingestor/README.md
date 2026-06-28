# PropAI Baileys Ingestor

Custom WhatsApp ingestion service for PropAI. It connects with Baileys, listens for WhatsApp messages, and posts Evolution-compatible webhook payloads to the existing PropAI API.

## Install

```bash
cd services/baileys-ingestor
npm install
```

## Run

Start the PropAI API first:

```bash
cd ../..
python3 -m uvicorn app:app --host 0.0.0.0 --port 8000
```

Then start Baileys:

```bash
cd services/baileys-ingestor
npm run dev
```

Scan the QR code with WhatsApp. New group messages will be sent to:

```text
http://localhost:8000/webhook
```

## Environment

Copy `.env.example` to `.env` if you want to override defaults.

```text
PROPAI_WEBHOOK_URL=http://localhost:8000/webhook
PROPAI_INSTANCE_NAME=propai-baileys
BAILEYS_AUTH_DIR=auth
PROPAI_INGEST_PRIVATE_CHATS=false
PROPAI_GROUP_ALLOWLIST=
PROPAI_GROUP_DENYLIST=
PROPAI_CAPTURE_HISTORY_SYNC=false
```

`PROPAI_GROUP_ALLOWLIST` and `PROPAI_GROUP_DENYLIST` accept comma-separated group JIDs or case-insensitive name fragments.

## History

Baileys can capture messages delivered by WhatsApp during history sync, but WhatsApp does not guarantee full old group history. Treat this as opportunistic. For deterministic backfill, use WhatsApp chat exports.

History sync is disabled by default so first pairing does not flood PropAI with thousands of old messages. Enable it deliberately with:

```text
PROPAI_CAPTURE_HISTORY_SYNC=true
```
