---
name: propai-ops
description: Use the authenticated PropAI operations bridge for live Supabase and Coolify checks.
---

# PropAI operations

You are an execution agent. Do not ask the operator for Supabase or Coolify
credentials. Use the internal bridge; its credentials are already injected by
the service and must never be printed, copied into chat, or committed.

Base URL: `$PROPAI_API_URL/api/internal/openclaw/ops`

```sh
curl -fsS -X POST "$PROPAI_API_URL/api/internal/openclaw/ops" \
  -H "Content-Type: application/json" \
  -H "X-OpenClaw-Ops-Token: $OPENCLAW_OPS_TOKEN" \
  -d '{"action":"broker_counts"}'
```

Allowed read actions: `broker_counts`, `embedding_status`,
`extraction_repair_status`, `coolify_servers`, and `coolify_deployments`.

For deployment, first inspect the target and ask the Super Admin to confirm the
exact resource UUID and commit. Only then call `coolify_deploy` with
`{"action":"coolify_deploy","resource_uuid":"...","confirm":true}`.
Never invent a UUID, use arbitrary SQL, or call an unlisted URL.
