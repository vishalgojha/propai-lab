# PropAI's isolated OpenClaw Gateway.
# The upstream image is maintained and released by OpenClaw; this wrapper only
# adds a source checkout for repository-grounded operations prompts.
ARG OPENCLAW_IMAGE=ghcr.io/openclaw/openclaw:latest
FROM ${OPENCLAW_IMAGE}

USER root
# The compose deployment supplies the repository as its build context. Copying
# that exact revision avoids a second unauthenticated GitHub clone during the
# image build (which is both non-reproducible and vulnerable to GitHub 429s).
COPY --chown=node:node . /opt/propai-source

COPY --chown=node:node deploy/openclaw/openclaw.json /opt/propai-openclaw.json
COPY --chown=node:node deploy/openclaw/start.sh /opt/start-propai-openclaw.sh
COPY --chown=node:node deploy/openclaw/propai-ops-skill.md /opt/propai-ops-skill.md
RUN chmod 0755 /opt/start-propai-openclaw.sh

USER node
ENV HOME=/home/node \
    OPENCLAW_HOME=/home/node \
    OPENCLAW_STATE_DIR=/home/node/.openclaw \
    OPENCLAW_CONFIG_DIR=/home/node/.openclaw \
    OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json \
    OPENCLAW_GATEWAY_PORT=18789

EXPOSE 18789
ENTRYPOINT ["/opt/start-propai-openclaw.sh"]
