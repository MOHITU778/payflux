# ─── Stage 1: dependencies ──────────────────────────────────────────────────
# Split from the build so that a source-only change does not invalidate the
# npm layer — the single biggest win in Docker build times for Node services.
FROM node:20-alpine AS deps

WORKDIR /app
COPY package*.json ./
# `npm ci` installs exactly what the lockfile pins: reproducible, and it fails
# loudly if package.json and the lockfile have drifted.
RUN npm ci --omit=dev && npm cache clean --force

# ─── Stage 2: runtime ───────────────────────────────────────────────────────
FROM node:20-alpine AS runtime

# dumb-init is PID 1 so signals actually reach Node. Without it, Node runs as
# PID 1, does not get default signal handlers, and SIGTERM is ignored — the
# container is then SIGKILLed after the grace period, killing in-flight
# payments and defeating the graceful-shutdown code entirely.
RUN apk add --no-cache dumb-init curl

ENV NODE_ENV=production
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package*.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node scripts ./scripts

# Never run as root: a container escape should not start with uid 0.
USER node

EXPOSE 4000

# Uses the liveness probe, which deliberately does not touch Mongo or Redis —
# see health.controller.js for why.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://localhost:4000/health/live || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
