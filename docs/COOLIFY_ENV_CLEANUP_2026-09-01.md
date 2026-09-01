# Coolify environment cleanup — 2026-09-01

## Completed

Removed 15 confirmed stale environment-variable entries from Coolify,
covering production and preview scopes where present:

- `gmail-ingestor`: `AP_DB_TYPE`, `AP_REDIS_TYPE`, `AP_FRONTEND_URL`, and
  `AP_TELEMETRY_ENABLED` (eight entries total across both scopes)
- `www`: `LITELLM_MASTER_KEY` (preview scope)
- `www`, `main-app`, and `propai-broker`: `NVIDIA_API_KEY_4` (six entries
  total across both scopes)

## Preserved

The Social Flow configuration was intentionally left unchanged:

- `SOCIAL_SDK_CONFIG_PATH`
- `SOCIAL_META_GRAPH_VERSION`

Both remain present in production and preview scopes.

## Deployment impact

The removed variables were not referenced by the PropAI application code or
required Docker build arguments. Existing running containers may retain their
old process environment until their next restart or redeployment. If an
immediate environment cleanup is desired, redeploy `gmail-ingestor`, `www`,
`main-app`, and `propai-broker`; no database migration is required.

No other Coolify variables were changed. Active or ambiguous variables remain
for a separate usage-and-runtime review.
