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
