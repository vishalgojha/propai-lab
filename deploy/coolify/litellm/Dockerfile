# LiteLLM gateway — shared PropAI LLM proxy
FROM python:3.12-slim

WORKDIR /app

# litellm proxy + supabase callback dependency
RUN pip install --no-cache-dir "litellm[proxy]" supabase

COPY deploy/coolify/litellm/config.yaml /app/config.yaml
COPY deploy/coolify/litellm/start.sh /app/start.sh
RUN chmod +x /app/start.sh

EXPOSE 4000

# LITELLM_MASTER_KEY + provider keys + SUPABASE_* are injected as
# Coolify secrets / env (never hardcoded here).
CMD ["/app/start.sh"]
