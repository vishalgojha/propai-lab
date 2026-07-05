# Coolify + Hetzner deployment

Use this stack for a Hetzner Cloud VPS managed by Coolify.

## Services

- `app` runs the Next.js frontend
- `api` runs the FastAPI backend
- `ingestor` runs the Baileys WhatsApp bridge

There is no dedicated MCP server in this repository yet. If you want `mcp.propai.live`, add a separate MCP service first, then point the subdomain at it in Coolify.

## Suggested domains

- `app.propai.live` -> broker platform (`app`)
- `www.propai.live` -> client platform (`app`)
- `api.propai.live` -> API (`api`)
- `propai.live` -> redirect to `app.propai.live` unless you want a separate marketing shell
- `mcp.propai.live` -> future MCP service

## Persistent data

Mount one persistent volume for:

- the SQLite database at `/data/lab.db`
- Baileys auth state at `/data/baileys/auth`
- Baileys status at `/data/baileys/status.json`

## Notes

- The frontend now rewrites `/api/*` to `http://api:8000/api/*` inside the Docker network.
- Coolify can issue and renew Let’s Encrypt certificates for custom domains.
- Coolify can deploy to any SSH-reachable server, including Hetzner Cloud.
