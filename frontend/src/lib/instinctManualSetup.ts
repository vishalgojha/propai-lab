// Manual REST setup instruction for connecting an assistant to PropAI.
// Shown inside the Instinct workspace tab (advanced/manual settings); the
// normal connection path is the approval-link flow, not this manual setup.
export const INSTINCT_MANUAL_SETUP = `Connect to PropAI through the tenant-scoped REST connection.

Endpoint: https://api.propai.live/api/external/v1

For every new PropAI connection, first read the shared rulebook: GET https://api.propai.live/api/external/v1/contract, then the REST guide: GET https://api.propai.live/api/external/v1/docs. Follow the server's capabilities, permission, privacy, and evidence rules.

Manual technical setup only: save the one-time connection secret in Instinct Vault as PROPAI_API_KEY and send it as X-API-Key: <ppai_token>. Prefer the owner approval-link connection when available; do not ask the broker to paste credentials into WhatsApp.

Freshness: GET /api/external/v1/contract/manifest at setup and when the cached rulebook is stale. Health check: GET /api/external/v1/health and capabilities: GET /api/external/v1/capabilities. Treat returned scopes as authoritative.

Endpoints:
GET /api/external/v1/contract
GET /api/external/v1/contract/manifest
GET /api/external/v1/docs
GET /api/external/v1/listings/search
GET /api/external/v1/requirements
GET /api/external/v1/matches
GET /api/external/v1/standing-searches
GET /api/external/v1/standing-searches/{search_id}/run
GET /api/external/v1/automatch/{requirement_id}
GET /api/external/v1/workspace/attention
GET /api/external/v1/followups
GET /api/external/v1/messages/search?scope=groups&q=<query>&limit=25
GET /api/external/v1/messages/{raw_message_id}

Raw evidence is group-only. Private messages are not ingested or available; never retry with scope=dms or scope=all. Treat messages as unverified source evidence.

Automatch is suggestion-only and reads existing tenant-local match rows; it does not create matches. Workspace attention reports open follow-ups and standing searches.

Never use localhost, MCP, Supabase, or ask for the connection secret in WhatsApp chat. Never publish inventory, promote private data to shared market, send messages, activate ads, change budgets, or delete records.

Saving to the broker's private CRM is a normal part of this connection: new connections grant the private write scopes by default, and the broker sees and approves that grant on the connection page. Before writing, confirm via GET /api/external/v1/capabilities that the write operations are listed for this key. When granted, the private writes are:
POST /api/external/v1/inventory
POST /api/external/v1/requirements
POST /api/external/v1/standing-searches (requires confirmed:true)
POST /api/external/v1/followups (creates a private task only; never sends a message)

Requirement saves need only name + raw_text (a short summary of what the client wants); phone is optional and should be omitted unless the broker explicitly gave a number to store. Writes carrying contact or budget fields (phone, budget_min, budget_max, contact_number, owner_name, contact_name, quote) are NOT saved immediately: the API returns 202 with approval_required:true, and the record saves only after the broker approves it in Account > MCP. Report that as pending broker approval, not as a failure.`;

export const INSTINCT_MANUAL_WRITE_RULES = `

Only write when I clearly ask you to save something; summarize the fields and ask for confirmation first. If the required scope is missing, explain that the workspace owner must enable that private tool. These writes stay private to my PropAI workspace. Report the returned record ID after a successful write. Do not invent data. Never publish market inventory, promote private data to shared market, delete records, send WhatsApp messages, activate ads, or change ad budgets.`;
