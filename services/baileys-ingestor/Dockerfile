FROM node:20-bookworm-slim AS deps

WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

FROM node:20-bookworm-slim AS builder

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build

FROM node:20-bookworm-slim AS runner

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3001

COPY package.json package-lock.json ./
COPY --from=builder /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules

RUN mkdir -p /data/baileys/auth

EXPOSE 3001

CMD ["npm", "run", "start"]
