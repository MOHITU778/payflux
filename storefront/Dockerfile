FROM node:20-alpine

# dumb-init as PID 1 so SIGTERM actually reaches Node rather than being ignored.
RUN apk add --no-cache dumb-init curl

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY --chown=node:node server.js ./
COPY --chown=node:node public ./public

USER node
EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8081/healthz || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
