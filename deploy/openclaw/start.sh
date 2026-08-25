#!/bin/sh
set -eu

: "${OPENCLAW_GATEWAY_TOKEN:?OPENCLAW_GATEWAY_TOKEN is required}"
: "${OPENCLAW_MODEL_BASE_URL:?OPENCLAW_MODEL_BASE_URL is required}"
: "${OPENCLAW_MODEL_API_KEY:?OPENCLAW_MODEL_API_KEY is required}"
: "${OPENCLAW_MODEL_ID:?OPENCLAW_MODEL_ID is required}"

STATE_DIR="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"
WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$STATE_DIR/workspace}"
mkdir -p "$STATE_DIR" "$WORKSPACE_DIR"

# Keep the agent checkout separate from the API container. It is refreshed only
# when the persistent workspace is empty, so agent edits survive restarts.
if [ ! -d "$WORKSPACE_DIR/.git" ]; then
  cp -a /opt/propai-source/. "$WORKSPACE_DIR/"
fi

# Config is generated from a tracked template and resolves secrets from the
# process environment through OpenClaw's native ${ENV_VAR} substitution.
if [ ! -f "$OPENCLAW_CONFIG_PATH" ]; then
  cp /opt/propai-openclaw.json "$OPENCLAW_CONFIG_PATH"
fi

exec node /app/openclaw.mjs gateway --bind lan --port "${OPENCLAW_GATEWAY_PORT:-18789}"
