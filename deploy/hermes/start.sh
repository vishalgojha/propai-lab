#!/bin/sh
set -eu

# Give the agent a real PropAI checkout while keeping it separate from the API
# container. The image contains a read-only baseline; this copy is the agent's
# isolated workspace for inspection, patches, and tests.
PROPAI_REPO_PATH="${PROPAI_REPO_PATH:-/workspace/propai}"
mkdir -p "$PROPAI_REPO_PATH"
if [ ! -d "$PROPAI_REPO_PATH/.git" ]; then
  cp -a /opt/propai-source/. "$PROPAI_REPO_PATH/"
fi
cd "$PROPAI_REPO_PATH"

# Keep the provider selection in Hermes' durable config while keeping the
# actual key in the runtime environment. This makes restarts deterministic and
# avoids putting a provider secret in config.yaml.
if [ -n "${OPENAI_BASE_URL:-}" ] && [ -n "${HERMES_MODEL:-}" ]; then
  hermes config set model.provider custom >/dev/null
  hermes config set model.default "$HERMES_MODEL" >/dev/null
  hermes config set model.base_url "$OPENAI_BASE_URL" >/dev/null
  hermes config set model.api_key '${OPENAI_API_KEY}' >/dev/null
fi

python3 /opt/configure-hermes.py

exec hermes gateway
