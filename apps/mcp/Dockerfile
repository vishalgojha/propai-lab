FROM node:22.23.5-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee
WORKDIR /app
COPY apps/mcp/package*.json ./
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
RUN npm ci --include=dev
COPY apps/mcp .
RUN npm run build
ENV PORT=3000
EXPOSE 3000
CMD ["node", "dist/server.js"]
