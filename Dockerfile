FROM node:22 AS builder

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm ci

COPY tsconfig.json ./
COPY ./src ./src

RUN npm run build

# FROM node:22-slim

# RUN apt-get update && apt-get install -y \
#     python3 \
#     python3-pip \
#     build-essential \
#     && rm -rf /var/lib/apt/lists/*

FROM ghcr.io/ruriazz/node22-py3-build:latest

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production

EXPOSE 3000

# HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
#     CMD node -e "require('http').get('http://localhost:3000/health', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })" || exit 1

CMD ["node", "dist/server.js"]