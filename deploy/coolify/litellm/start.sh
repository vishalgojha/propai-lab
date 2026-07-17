#!/usr/bin/env bash
# Boot the LiteLLM proxy. Provider keys + SUPABASE_* + LITELLM_MASTER_KEY
# come from the environment (Coolify secrets). The supabase callback needs
# SUPABASE_URL and SUPABASE_SERVICE_KEY exported as shown below so the
# litellm supabase handler can reach the llm_routing_log table.
set -euo pipefail

export LITELLM_LOG="INFO"
export SUPABASE_URL="${SUPABASE_URL}"
export SUPABASE_KEY="${SUPABASE_SERVICE_KEY}"

exec litellm --config /app/config.yaml --host 0.0.0.0 --port 4000
