FROM node:20-slim
WORKDIR /app
COPY apps/mcp/package*.json ./
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*
RUN npm install
COPY apps/mcp .
RUN npx tsc
EXPOSE 3003
CMD ["node", "dist/server.js"]
