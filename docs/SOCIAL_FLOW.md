# Social Flow Realtor Ads Studio

PropAI exposes the Social Flow SDK through the authenticated `/social-flow` route.
The Studio creates plans and previews for Meta realtor campaigns; campaign creation
is explicitly paused/approval-gated.

## Deployment

Run `deploy/coolify/Dockerfile.social-flow` as a separate Coolify service from the
same repository. Give it persistent storage for the Social Flow config and set:

- `SOCIAL_GATEWAY_API_KEY`
- `SOCIAL_GATEWAY_REQUIRE_API_KEY=true`
- `SOCIAL_HOSTED_MASTER_KEY`
- `SOCIAL_SDK_CONFIG_PATH=/data/social-flow/config.json`

On the PropAI frontend service set:

- `SOCIAL_FLOW_SDK_URL=https://<internal-or-private-social-flow-service>`
- `SOCIAL_FLOW_SDK_API_KEY=<same gateway key>`

The browser only talks to PropAI. Meta tokens remain on the Social Flow service and
are never placed in `NEXT_PUBLIC_*` variables or rendered into HTML.

Hermes collects non-secret Meta setup details conversationally and saves them in
the tenant-scoped `social_flow_meta_settings` table. Access tokens must still be
connected through the server-side Social Flow setup; they are never sent to Hermes
or stored in the setup table.

## Creative lab

The `/social-flow` assistant includes a tenant-scoped creative lab. It accepts
private JPG, PNG, WEBP, GIF, MP4, MOV, and PDF uploads up to 20 MB and stores only
metadata plus a private storage key in `social_flow_assets`. The optional Hermes
creative pass receives short-lived signed URLs for the selected assets. Campaign
creation is approval-gated: Hermes proposes the exact action, PropAI signs it to
the current user/workspace and parameters, and the user must approve it before
Social Flow executes the paused campaign.

Enable it on the API service only after the isolated Hermes service is reachable:

- `SOCIAL_FLOW_AGENT_ENABLED=true`
- `HERMES_API_URL=http://hermes:8642/v1`
- `HERMES_API_KEY=<server-side-secret>`
- `SOCIAL_FLOW_SDK_URL=https://<internal-or-private-social-flow-service>`
- `SOCIAL_FLOW_SDK_API_KEY=<same gateway key>`

Live reports and campaign status are fetched through the read-only SDK bridge.
Campaign creation, activation, pausing, budget changes, and creative uploads are
approval-gated in the Social Flow executor. Every mutation uses the same
tenant-bound, signed-parameter approval boundary. Do not expose Hermes or Social
Flow credentials to the frontend.

## Meta Ads MCP connector

The API can also connect to Meta's remote Ads MCP server. This is separate from
the Social Flow gateway and must be configured on the API service only. PropAI
uses the Meta Developer App OAuth flow to obtain a workspace token; it does not
depend on Meta's hosted MCP OAuth metadata discovery:

- `META_ADS_MCP_ENABLED=true`
- `META_ADS_MCP_URL=https://mcp.facebook.com/ads`
- `PROPAI_TOKEN_ENCRYPTION_KEY=<base64 Fernet key, generated once for the API>`
- `META_APP_ID=<Meta Developer App ID>`
- `META_APP_SECRET=<Meta Developer App secret>`
- `META_REDIRECT_URI=https://app.propai.live/api/social-flow/meta/callback`

When configured, the API performs MCP `initialize` and `tools/list`, exposes only
read-only MCP tools to the PropAI Ads Agent, and executes those tools server-side.
The token is encrypted and stored per workspace after the user completes the
`Connect Meta` flow; it is never sent to the browser or Hermes. MCP mutation tools
are deliberately withheld until they are mapped into the existing PropAI approval
ledger. Setting the URL alone does not authenticate the connector.

The authenticated `/api/social-flow/connection` check uses the saved Page ID and
ad account ID to verify the Social Flow/Meta connection and records only the
connection state (`connected` or `not_connected`) in `social_flow_meta_settings`.
The setup helper can also open Meta Business settings in the workspace's
approval-scoped Agent Browser, extract visible Page/Ad Account IDs, and save only
those identifiers. It never imports browser cookies or Meta tokens into Hermes.

## Native chat and Meta Ads Kit capabilities

The PropAI chat is the broker-friendly entry point. It adapts the useful, read-only
Meta Ads Kit workflows to the Social Flow SDK instead of running shell scripts in the
browser:

- performance, daily status, winners and bleeders use `realtor_report`;
- creative-fatigue requests use an ad-level report;
- budget and pacing requests return recommendations only;
- property briefs use `realtor_build` and `realtor_preview`;
- campaign creation remains an explicit approval step and creates a paused campaign.

The SDK response from `realtor_build` is a presentation/draft response. Preview and
create receive the original broker request payload, which preserves the complete
brief and avoids silently losing fields between chat, review and approval.
