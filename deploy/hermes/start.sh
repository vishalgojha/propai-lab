#!/bin/sh
set -eu

# Keep the provider selection in Hermes' durable config while keeping the
# actual key in the runtime environment. This makes restarts deterministic and
# avoids putting a provider secret in config.yaml.
if [ -n "${OPENAI_BASE_URL:-}" ] && [ -n "${HERMES_MODEL:-}" ]; then
  hermes config set model.provider custom >/dev/null
  hermes config set model.default "$HERMES_MODEL" >/dev/null
  hermes config set model.base_url "$OPENAI_BASE_URL" >/dev/null
  hermes config set model.api_key '${OPENAI_API_KEY}' >/dev/null
fi

exec hermes gateway
