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
