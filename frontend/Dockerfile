# ─── Stage 1: build the Angular bundle ──────────────────────────────────────
FROM node:20-alpine AS build

WORKDIR /app
COPY package*.json ./
# Dev dependencies are required here: the Angular compiler is a build tool.
RUN npm ci

COPY . .
RUN npm run build -- --configuration production

# ─── Stage 2: serve the static bundle ───────────────────────────────────────
# nginx rather than `ng serve`: the dev server is single-threaded, unoptimised
# and explicitly not for production. The final image carries no Node runtime
# and no node_modules — a ~25MB image instead of ~400MB.
FROM nginx:1.27-alpine AS runtime

RUN rm /etc/nginx/conf.d/default.conf
COPY nginx.conf            /etc/nginx/conf.d/payflux.conf
COPY security-headers.conf /etc/nginx/conf.d/security-headers.conf
COPY --from=build /app/dist/payflux-console/browser /usr/share/nginx/html

EXPOSE 80

# 127.0.0.1, not `localhost`: busybox wget resolves `localhost` to ::1 first,
# and nginx only listens on IPv4 here — the probe would fail against a perfectly
# healthy container.
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -q --spider http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
