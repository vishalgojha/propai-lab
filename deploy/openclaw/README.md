# PropAI OpenClaw Operations Agent

This is the isolated replacement for the former Hermes service. It exposes
OpenClaw's private OpenAI-compatible Gateway to the PropAI API only; it is not
an end-user or public gateway.

## Coolify environment

Set these on the OpenClaw service:

```text
OPENCLAW_GATEWAY_TOKEN=<random-private-token>
OPENCLAW_MODEL_BASE_URL=https://api.doubleword.ai/v1
OPENCLAW_MODEL_API_KEY=<doubleword-key>
OPENCLAW_MODEL_ID=<model-enabled-for-this-key>
OPENCLAW_GATEWAY_PORT=18789
```

Set these on the API service:

```text
OPENCLAW_API_URL=http://openclaw:18789/v1
OPENCLAW_API_KEY=<same-gateway-token>
OPENCLAW_AGENT_MODEL=openclaw/default
```

Keep the OpenClaw service on the private Coolify network and do not attach a
public domain. The Gateway token is an operator credential, so it must never
reach the browser.
