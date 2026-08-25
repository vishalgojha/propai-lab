# PropAI OpenClaw Operations Agent

This is the isolated replacement for the former Hermes service. It exposes
OpenClaw's private OpenAI-compatible Gateway to the PropAI API only; it is not
an end-user or public gateway.

## Coolify environment

Set these on the OpenClaw service:

```text
OPENCLAW_GATEWAY_TOKEN=<random-private-token>
OPENROUTER_API_KEY=<openrouter-key>
OPENCLAW_GATEWAY_PORT=18789
PROPAI_API_URL=http://api:8000
OPENCLAW_OPS_TOKEN=<same-private-token-configured-on-the-api>
```

The default model chain is `openrouter/openrouter/free` first, followed by
`openrouter/deepseek/deepseek-v4-flash-0731` on rate limits, downtime, timeouts, or
other failover-worthy provider errors. OpenRouter's `openrouter/free` router
selects an available free model; DeepSeek is the paid fallback only when the
free attempt cannot complete.

Set these on the API service:

```text
OPENCLAW_API_URL=http://openclaw:18789/v1
OPENCLAW_API_KEY=<same-gateway-token>
OPENCLAW_AGENT_MODEL=openclaw/default
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

## Cutover and safety

Realtor Ads Studio and the super-admin operations agent are OpenClaw-only.
The API and frontend do not fall back to Hermes, even if old `HERMES_*`
variables are still present. Native `/api/social-flow/*` agent, setup, and
action paths forward to FastAPI; FastAPI calls the private OpenClaw gateway
using `OPENCLAW_API_URL`, `OPENCLAW_API_KEY`, and `OPENCLAW_AGENT_MODEL`.

After OpenClaw is installed and healthy, verify it before retiring Hermes:

```bash
openclaw doctor
openclaw status
```

On a host-managed Hermes installation, stop and disable it first, then archive
its state rather than deleting it immediately:

```bash
sudo systemctl disable --now hermes
mv ~/.hermes ~/.hermes.archived-$(date +%Y%m%d-%H%M%S)
```

If Hermes is a Coolify service, stop the service from Coolify and retain its
volume until an authenticated Ads Studio request and the operations-agent
health check both succeed. Do not leave a gateway exposed on `0.0.0.0` with an
unsandboxed local terminal backend; keep OpenClaw on the private network,
enable a sandboxed terminal backend, and configure platform user allowlists.
```
