#!/usr/bin/env bash
set -e

# ─── Auto-generate API key ───────────────────────────────────────────────
if [ -f .api_key ]; then
  API_KEY=$(cat .api_key)
else
  API_KEY=$(uuidgen)
  echo "$API_KEY" > .api_key
  echo "  Generated API key: $API_KEY"
fi

# ─── Start lab API if not running ────────────────────────────────────────
start_lab_api() {
  if curl -sf http://localhost:8000/ > /dev/null 2>&1; then
    return 0
  fi
  echo "  Starting lab API..."
  cd "$(dirname "$0")"
  nohup uvicorn app:app --host 0.0.0.0 --port 8000 > /tmp/lab-api.log 2>&1 &
  sleep 2
  if curl -sf http://localhost:8000/ > /dev/null 2>&1; then
    echo "  Lab API ready on http://localhost:8000"
  else
    echo "  Lab API starting... (check /tmp/lab-api.log)"
  fi
}

# ─── Speed up: skip if evolution-api already running ─────────────────────
if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^evolution-api$'; then
  echo "  evolution-api already running."
  echo "  API key: $API_KEY"
  start_lab_api
  echo ""
  echo "  Manager UI: http://localhost:8080/manager"
  echo "  Lab API:    http://localhost:8000"
  echo "  Admin UI:   http://localhost:8000/admin"
  echo ""
  echo "  Next → scan QR code with your phone:"
  echo ""
  # Show QR code
  curl -s "http://localhost:8080/instance/connect/propai-scraper" -H "apikey: $API_KEY" -o /tmp/qr_response.json 2>/dev/null || true
  QR_B64=$(python3 -c "
import json
with open('/tmp/qr_response.json') as f:
    d = json.load(f)
print(d.get('base64', ''))
" 2>/dev/null) || QR_B64=""
  if [ -n "$QR_B64" ]; then
    cat > /tmp/qr.html << EOF
<!DOCTYPE html><html><body style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#fff">
<img src="$QR_B64" alt="QR Code" style="max-width:90vw;max-height:90vh">
</body></html>
EOF
    echo "    Open file:///tmp/qr.html in your browser"
    echo ""
    (xdg-open file:///tmp/qr.html 2>/dev/null || open file:///tmp/qr.html 2>/dev/null || true)
  else
    echo "    curl -s 'http://localhost:8080/instance/connect/propai-scraper' -H 'apikey: $API_KEY'"
  fi
  exit 0
fi

# ─── Start containers ──────────────────────────────────────────────────
export AUTHENTICATION_API_KEY="$API_KEY"
echo ""
echo "  Starting Evolution API + PostgreSQL..."

docker compose up -d
echo ""

# ─── Wait for healthy ──────────────────────────────────────────────────
echo -n "  Waiting for evolution-api"
for i in $(seq 1 30); do
  if curl -sf http://localhost:8080/ > /dev/null 2>&1; then
    echo ""
    echo "  Container healthy after ${i}s"
    break
  fi
  echo -n "."
  sleep 1
done
echo ""

# ─── Create WhatsApp instance ──────────────────────────────────────────
echo "  Creating WhatsApp instance..."
INSTANCE_JSON=$(curl -sf -X POST http://localhost:8080/instance/create \
  -H "Content-Type: application/json" \
  -H "apikey: $API_KEY" \
  -d '{"instanceName": "propai-scraper", "integration": "WHATSAPP-BAILEYS"}') || {
  echo "  Instance already exists (or error) — continuing..."
  INSTANCE_JSON="{}"
}

echo "  Getting QR code..."
curl -sf "http://localhost:8080/instance/connect/propai-scraper" \
  -H "apikey: $API_KEY" -o /tmp/qr_response.json 2>/dev/null || true

# ─── Start lab API ──────────────────────────────────────────────────────
start_lab_api

# ─── Save QR code as HTML ──────────────────────────────────────────────
QR_B64=$(python3 -c "
import json
with open('/tmp/qr_response.json') as f:
    d = json.load(f)
print(d.get('base64', ''))
" 2>/dev/null) || QR_B64=""
if [ -n "$QR_B64" ]; then
  cat > /tmp/qr.html << EOF
<!DOCTYPE html><html><body style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#fff">
<img src="$QR_B64" alt="QR Code" style="max-width:90vw;max-height:90vh">
</body></html>
EOF
  echo "  QR code saved → file:///tmp/qr.html"
fi

# ─── Print summary ─────────────────────────────────────────────────────
echo ""
echo "  ╔══════════════════════════════════════════════════════════╗"
echo "  ║  Evolution API v2.3.7 is running                        ║"
echo "  ║  API key: $API_KEY  ║"
echo "  ╠══════════════════════════════════════════════════════════╣"
echo "  ║  URLs:                                                   ║"
echo "  ║    Manager UI : http://localhost:8080/manager            ║"
echo "  ║    Admin UI   : http://localhost:8000/admin              ║"
echo "  ║    Lab API    : http://localhost:8000                    ║"
echo "  ╠══════════════════════════════════════════════════════════╣"
echo "  ║  1. Scan QR → open this in your browser:                 ║"
echo "  ║     file:///tmp/qr.html                                  ║"
echo "  ║                                                          ║"
echo "  ║  2. Once connected, sync a group:                        ║"
echo "  ║     curl -X POST http://localhost:8000/api/sources/whatsapp/sync \\  ║"
echo "  ║       -H 'Content-Type: application/json' \\              ║"
echo "  ║       -d '{\"instance\":\"propai-scraper\",\"group_id\":\"...@g.us\"}'  ║"
echo "  ║                                                          ║"
echo "  ║  3. Check sync status:                                   ║"
echo "  ║     curl http://localhost:8000/api/sources/status        ║"
echo "  ╚══════════════════════════════════════════════════════════╝"
echo ""
