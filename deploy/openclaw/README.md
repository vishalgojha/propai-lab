# PropAI OpenClaw Operations Agent

This is the isolated operations-agent service. It exposes OpenClaw's private
OpenAI-compatible Gateway to the PropAI API only; it is not
an end-user or public gateway.

## Coolify environment

Set these on the OpenClaw service:

```text
OPENCLAW_GATEWAY_TOKEN=<random-private-token>
SARVAM_API_KEY=<sarvam-key>
OPENCLAW_GATEWAY_PORT=18789
PROPAI_API_URL=http://api:8000
OPENCLAW_OPS_TOKEN=<same-private-token-configured-on-the-api>
```

OpenClaw uses Sarvam as its only model provider through the OpenAI-compatible
Sarvam endpoint (`sarvam-105b-conversations`). There is no OpenRouter or
Doubleword fallback in the OpenClaw chain.

Set these on the API service:

```text
OPENCLAW_API_URL=http://openclaw:18789/v1
OPENCLAW_API_KEY=<same-gateway-token>
OPENCLAW_AGENT_MODEL=openclaw/default
OPENCLAW_SELF_CHAT_ENABLED=true
OPENCLAW_SELF_CHAT_MODEL=openclaw/default
```

Keep the OpenClaw service on the private Coolify network and do not attach a
public domain. The Gateway token is an operator credential, so it must never
reach the browser.

The `propai-ops` skill gives OpenClaw scoped live diagnostics through the API
bridge. Keep `SUPABASE_SERVICE_KEY` and `COOLIFY_API_TOKEN` on the API service;
do not add either secret to OpenClaw. Configure these API-side variables for
Coolify inspection/deployment access:

```text
OPENCLAW_OPS_TOKEN=<same-private-token-configured-on-openclaw>
COOLIFY_API_URL=https://<your-coolify-host>
COOLIFY_API_TOKEN=<coolify-api-token>
COOLIFY_ALLOWED_PROJECT_UUID=jk70gpotmsmr38fn3lwp986k
COOLIFY_ALLOWED_ENVIRONMENT_UUID=yki5ez2t6ysqjgdcuz2o5xpv
```

## Cutover and safety

Realtor Ads Studio and the super-admin operations agent are OpenClaw-only.
The API and frontend use OpenClaw only. Native `/api/social-flow/*` agent, setup, and
action paths forward to FastAPI; FastAPI calls the private OpenClaw gateway
using `OPENCLAW_API_URL`, `OPENCLAW_API_KEY`, and `OPENCLAW_AGENT_MODEL`.
WhatsApp self-chat uses the same private gateway through the API, with the
optional `OPENCLAW_SELF_CHAT_MODEL`, and never inserts owner messages into the
market `raw_messages` extraction queue.

After OpenClaw is installed and healthy, verify it:

```bash
openclaw doctor
openclaw status
```

Do not leave a gateway exposed on `0.0.0.0` with an
unsandboxed local terminal backend; keep OpenClaw on the private network,
enable a sandboxed terminal backend, and configure platform user allowlists.
```
