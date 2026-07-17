# PropAI Shared LLM Gateway (LiteLLM)

A single internal OpenAI-compatible proxy that **every** PropAI service routes
through for LLM inference. One place for provider config, one dashboard for
total usage, and free-tier cost savings on non-customer-facing workloads.

```
PropAI service  ──OpenAI SDK──▶  litellm-gateway:4000  ──▶  provider (Doubleword / Groq / …)
                                       │
                                       └──▶ writes llm_routing_log (Supabase)
```

## Why

- Previously every module hardcoded `api.doubleword.ai/v1`. The gateway
  centralizes routing so adding a provider or changing a task's provider is a
  **config change only** — no app code edits.
- `task_type` is the single discipline that keeps "shared" from becoming
  "undifferentiated": chat always goes to Doubleword for quality; batch
  jobs try free tiers first.

## How routing works

Callers send `model = <task_type>` to the gateway. The gateway maps the
task_type to a provider group with a fallback chain.

| task_type       | Primary        | Fallback chain (on 429/5xx)                                  | Notes |
|-----------------|----------------|--------------------------------------------------------------|-------|
| `chat`          | Doubleword     | (Doubleword only)                                            | Customer-facing WhatsApp. Quality > cost. |
| `extraction`    | Groq           | Gemini → NVIDIA NIM → Cerebras → Mistral → OpenRouter → Doubleword | micro_market + building resolvers |
| `classification`| Groq           | same chain → Doubleword                                      | knowledge classifier |
| `batch`         | Doubleword     | (Doubleword only)                                            | Doubleword Batch API (direct, not proxied) |
| `default`       | Doubleword     | (Doubleword only)                                            | correction layer / legacy callers |
| `embeddings`    | — (reserved)   | —                                                            | PropAI uses LOCAL embeddings; no provider call yet |

`router_settings.num_retries=3`, `cooldown_time=30s` handle 429s with automatic
cooldown + next-provider retry.

## Files

- `deploy/coolify/litellm/config.yaml` — routing + fallback config (edit this).
- `deploy/coolify/litellm/hooks.py` — writes one row per request to Supabase.
- `deploy/coolify/litellm/Dockerfile` + `start.sh` — container.
- `deploy/coolify/docker-compose.yml` — `litellm-gateway` service; `api` and
  `extraction-worker` now point `DOUBLEWORD_API_URL` at it (`http://litellm-gateway:4000`).
- `supabase/migrations/20260717170000_llm_routing_log.sql` — log table + `llm_provider_failure_rates()`.
- `deploy/coolify/litellm/alert.py` — cron alert job.

## Coolify secrets (never hardcoded)

Gateway container needs:
`LITELLM_MASTER_KEY` (any string; services use it as their `DOUBLEWORD_API_KEY`)
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
`DOUBLEWORD_API_URL`, `DOUBLEWORD_API_KEY`
`GROQ_API_KEY`, `GEMINI_API_KEY`, `NVIDIA_API_KEY`, `CEREBRAS_API_KEY`,
`MISTRAL_API_KEY`, `OPENROUTER_API_KEY`  (free tiers — optional; absent = skipped)

`api` / `extraction-worker` use `DOUBLEWORD_API_KEY=${LITELLM_MASTER_KEY}` so they
authenticate to the gateway, not directly to providers.

> The **frontend** (`frontend/src/lib/ai-provider.ts`) keeps calling Doubleword
> directly — it's customer-facing chat and must not expose the master key in the
> browser. It is intentionally NOT routed through the gateway.

## Free-tier limits (as of 2026-07-17 — verify before relying on them)

| Provider     | Free tier limit (approx)                                   | ToS commercial use |
|--------------|------------------------------------------------------------|--------------------|
| Groq         | ~14k req/day, 30 req/min (Llama 70B)                       | ✅ checked 2026-07-17 |
| Gemini Flash | 1.5B tokens/day, 15 req/min (free tier)                    | ⚠ NOT checked |
| NVIDIA NIM   | per-model; Nemotron free, generous                         | ⚠ NOT checked (Inception membership may add credits) |
| Cerebras     | 10–30 req/min free (Llama 70B)                             | ⚠ NOT checked |
| Mistral      | limited free tier / La Plateforme free credits             | ⚠ NOT checked |
| OpenRouter   | free model pool, rate-limited                              | ⚠ NOT checked |
| Doubleword   | paid                                                       | n/a |

Free tiers change terms often. Re-check ToS for commercial use before enabling
a provider in production, and update the comment block at the top of
`config.yaml`.

## Adding a new provider

1. Add the key as a Coolify secret (e.g. `NEWPROVIDER_API_KEY`).
2. In `config.yaml` `model_list`, add a deployment:
   ```yaml
   - model_name: newprovider-deploy
     litellm_params:
       model: newprovider/model-id
       api_key: ${NEWPROVIDER_API_KEY}
   ```
3. Append `newprovider-deploy` to the relevant `fallbacks` list(s) under
   `router_settings`. No app code changes.

## Adding a new task_type

1. Decide the provider group + fallback chain; add a `model_name: <task_type>`
   entry in `model_list` (primary deployment) and a `fallbacks` entry.
2. In the calling service, send `model="<task_type>"` (already done via the
   `LLM_TASK_MODEL` env override or hardcoded group name in resolvers/classifier/
   correction layer/chat engine).
3. The hook already records `task_type` from the model name. Done.

## Alerting

`deploy/coolify/litellm/alert.py` runs on a schedule (Coolify scheduled task, every
15–30 min). It calls `llm_provider_failure_rates()` and, for any provider with
>50% failures over the last 10+ calls, sends a WhatsApp message via the existing
whatsmeow ingestor (`INGESTOR_INTERNAL_URL`) to `ALERT_WHATSAPP_NUMBERS`.

Set as a Coolify scheduled task:
```
python deploy/coolify/litellm/alert.py
```
with env: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `INGESTOR_INTERNAL_URL`,
`ALERT_WHATSAPP_NUMBERS` (comma-separated), optional `ALERT_WINDOW_MINUTES`,
`ALERT_MIN_CALLS`, `ALERT_MAX_FAILURE_RATE`.

## Rollout status

1. ✅ Gateway + log table + alerting stood up (initially Doubleword-only until
   free-tier keys are added).
2. ✅ Resolvers (location/building) pointed at gateway, `task_type=extraction`,
   and their swallowed-exception bug fixed (now `logger.warning` on failure).
3. ⏳ Classification/embeddings jobs route via gateway as built (embeddings are
   local; classification uses `default`=Doubleword for now).
4. ✅ Chat engine routes `task_type=chat` → Doubleword via gateway (config-only;
   behavior unchanged).
