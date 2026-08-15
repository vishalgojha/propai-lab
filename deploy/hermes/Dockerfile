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

# Keep the agent isolated from PropAI's application runtime. The source checkout
# is copied into a dedicated writable workspace at startup; the live API
# container filesystem is never mounted into the agent.
ARG HERMES_REF=main
ARG PROPAI_REF=main
RUN git clone --depth 1 --branch "$HERMES_REF" \
      https://github.com/NousResearch/hermes-agent.git /opt/hermes-agent \
    && git clone --depth 1 --branch "$PROPAI_REF" \
      https://github.com/vishalgojha/propai-lab.git /opt/propai-source \
    && uv venv /opt/hermes-venv --python python3.11 \
    && uv pip install --python /opt/hermes-venv/bin/python \
      -e "/opt/hermes-agent[all]"

RUN mkdir -p /data/.hermes /workspace

ENV PATH="/opt/hermes-venv/bin:$PATH"
WORKDIR /data
VOLUME ["/data"]
EXPOSE 8642

COPY deploy/hermes/configure.py /opt/configure-hermes.py
COPY deploy/hermes/start.sh /opt/start-hermes.sh
RUN chmod +x /opt/start-hermes.sh

CMD ["/opt/start-hermes.sh"]
