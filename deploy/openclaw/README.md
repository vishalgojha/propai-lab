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
```

The default model chain is `openrouter/openrouter/free` first, followed by
`openrouter/deepseek/deepseek-chat` on rate limits, downtime, timeouts, or
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
