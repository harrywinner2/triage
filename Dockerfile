# Triage — production image.
# Multi-stage-ish single file: install deps, compile TS, prune dev deps, run.
FROM node:20-slim

WORKDIR /app

# `tar` is used at runtime to extract uploaded support bundles.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tar ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Don't pull Playwright browsers into the server image — Playwright is a local-only
# dev tool (verify + demo capture), not used by the deployed app.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY samples ./samples

RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/index.js"]
