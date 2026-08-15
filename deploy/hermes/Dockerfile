FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HOME=/data \
    API_SERVER_ENABLED=true \
    API_SERVER_HOST=0.0.0.0 \
    API_SERVER_PORT=8642 \
    API_SERVER_MODEL_NAME=hermes-admin

WORKDIR /opt

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git curl build-essential \
    && pip install --no-cache-dir uv \
    && rm -rf /var/lib/apt/lists/*

# Keep Hermes isolated from PropAI's application runtime. The ref can be
# pinned in Coolify later for reproducible upgrades; main is the initial
# integration target while the service is being validated.
ARG HERMES_REF=main
RUN git clone --depth 1 --branch "$HERMES_REF" \
      https://github.com/NousResearch/hermes-agent.git /opt/hermes-agent \
    && uv venv /opt/hermes-venv --python python3.11 \
    && uv pip install --python /opt/hermes-venv/bin/python \
      -e "/opt/hermes-agent[all]"

RUN mkdir -p /data/.hermes

ENV PATH="/opt/hermes-venv/bin:$PATH"
WORKDIR /data
VOLUME ["/data"]
EXPOSE 8642

CMD ["hermes", "gateway"]
