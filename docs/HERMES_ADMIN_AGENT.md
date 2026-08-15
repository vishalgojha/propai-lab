# Hermes Super Admin Agent

PropAI's customer AI chat and the Super Admin operations agent are separate
systems. Customer chat remains tenant-scoped and keeps its existing bounded
tool loop. Hermes is an internal coding and operations worker, reachable from
`/admin/hermes` only after the normal Supabase session is authenticated and
the user is present in the Super Admin allowlist.

## Deployment contract

Run Hermes as a separate, isolated service and point the API service at its
OpenAI-compatible endpoint:

```text
HERMES_API_URL=http://hermes:8642/v1
HERMES_API_KEY=<server-side-secret>
HERMES_AGENT_MODEL=hermes-admin
```

The Hermes service should have:

- a dedicated workspace checkout, never the live API container filesystem;
- only the PropAI context files and an explicitly filtered MCP server;
- `API_SERVER_ENABLED=true`, a random `API_SERVER_KEY`, and no public CORS;
- command approvals enabled (`smart` or `manual`), never `off` in production;
- no Supabase service-role key in the agent environment.

The initial PropAI bridge is intentionally stateless and non-streaming. It
keeps the server credential out of the browser and bounds prompt/history size.
The next integration layer should add Hermes Runs/SSE for tool progress and a
PropAI MCP server exposing read-only schema/data inspection first. Migration
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

Hermes can use MCP to connect to internal systems, but the server should
expose the smallest useful tool surface. Do not connect a broad filesystem or
unfiltered database tool.
