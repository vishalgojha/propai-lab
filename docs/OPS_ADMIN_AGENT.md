# OpenClaw Super Admin Agent

PropAI's customer AI chat and the Super Admin operations agent are separate
systems. Customer chat remains tenant-scoped and keeps its existing bounded
tool loop. OpenClaw is an internal coding and operations worker, reachable from
`/admin/ops` only after the normal Supabase session is authenticated and
the user is present in the Super Admin allowlist.

## Deployment contract

Run OpenClaw as a separate, isolated service and point the API service at its
private OpenAI-compatible Gateway endpoint:

```text
OPENCLAW_API_URL=http://openclaw:18789/v1
OPENCLAW_API_KEY=<server-side-gateway-token>
OPENCLAW_AGENT_MODEL=openclaw/default
```

The OpenClaw service should have:

- a dedicated workspace checkout, never the live API container filesystem;
- only the PropAI context files and explicitly enabled plugins;
- Gateway chat completions enabled only on the private service network;
- a random Gateway token, never a public domain or browser-visible key;
- production mutations kept behind the PropAI approval boundary;
- no Supabase service-role key in the agent environment.

The initial PropAI bridge is intentionally stateless and non-streaming. It
keeps the server credential out of the browser and bounds prompt/history size.
OpenClaw's Gateway runs the agent/tool loop; the PropAI bridge remains the
auth, tenant, persistence, and approval boundary. Migration
application, code writes, deploys, and WhatsApp actions must each produce a
reviewable diff/approval event before execution.

## Recommended tool tiers

1. Read-only: repository search, git status/diff, Supabase schema, safe SQL
   explain/select, logs, worker health, and test discovery.
2. Draft: migration files, code patches, test commands, and incident reports.
3. Apply with approval: run tests, apply a named migration, restart a named
   worker, or prepare a deployment.
4. Never autonomous: production destructive SQL, deleting inventory, sending
   WhatsApp messages, changing tenant permissions, or exposing credentials.

OpenClaw can use plugins and skills to connect to internal systems, but the
server should expose the smallest useful tool surface. Do not connect a broad
filesystem or unfiltered database tool.
