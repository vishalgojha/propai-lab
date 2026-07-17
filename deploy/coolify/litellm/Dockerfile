# LiteLLM gateway — shared PropAI LLM proxy
FROM python:3.12-slim

WORKDIR /app

# litellm (proxy entrypoint ships with base package) + supabase callback dep.
# Avoid the heavy [proxy] extra (orjson/rust) to keep the build reliable on
# the Coolify host's non-BuildKit Docker.
RUN pip install --no-cache-dir litellm supabase

# Copy the whole gateway package so `deploy.coolify.litellm.hooks` is importable.
COPY deploy/coolify/litellm/ /app/deploy/coolify/litellm/
RUN ln -s /app/deploy/coolify/litellm/config.yaml /app/config.yaml

ENV PYTHONPATH=/app

EXPOSE 4000

# LITELLM_MASTER_KEY + provider keys + SUPABASE_* are injected as
# Coolify secrets / env (never hardcoded here).
CMD ["litellm", "--config", "/app/config.yaml", "--host", "0.0.0.0", "--port", "4000"]

