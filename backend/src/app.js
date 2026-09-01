'use strict';

const express = require('express');
const swaggerUi = require('swagger-ui-express');
const config = require('./config');
const swaggerSpec = require('./config/swagger');
const middlewares = require('./middlewares');
const v1Routes = require('./routes/v1');
const healthController = require('./controllers/health.controller');

/**
 * Express application assembly.
 *
 * The mount order below *is* the request pipeline, and each position is
 * deliberate. Read it top to bottom as the path a request takes.
 */
function createApp() {
  const app = express();

  // Behind a load balancer, `req.ip` must come from X-Forwarded-For or every
  // client looks like the proxy — which would break rate limiting and make the
  // fraud engine's IP velocity rule useless. `1` trusts exactly one hop; a bare
  // `true` would let a client spoof its own IP by sending the header itself.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.disable('etag'); // no conditional-GET semantics on a mutable payments API

  // ── 1. Trace context — must be first so everything downstream can log it ──
  app.use(middlewares.requestContext);

  // ── 2. Security headers, CORS, compression ───────────────────────────────
  app.use(middlewares.security.helmet());
  app.use(middlewares.security.cors());
  app.use(middlewares.security.compression());

  // ── 3. Body parsing ──────────────────────────────────────────────────────
  // The raw body is retained for webhook signature verification: the HMAC is
  // computed over the exact bytes sent, and re-serialising the parsed object
  // would produce different bytes and a failed signature.
  app.use(express.json({
    limit: '256kb',
    verify: (req, _res, buffer) => { req.rawBody = buffer; },
  }));
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  // ── 4. NoSQL injection defence, after parsing, before any handler ────────
  app.use(middlewares.security.mongoSanitize);

  // ── 5. Access logs and HTTP metrics ──────────────────────────────────────
  app.use(middlewares.requestLogger);

  // ── 6. Operational endpoints — deliberately unauthenticated and
  //       un-rate-limited so a probe never fails because of a quota. ────────
  app.get('/health', healthController.detail);
  app.get('/health/live', healthController.live);
  app.get('/health/ready', healthController.ready);
  app.get('/metrics', healthController.metrics);

  // ── 7. Global rate limit, applied only to the API surface ────────────────
  app.use(config.apiPrefix, middlewares.rateLimit.global());

  // ── 8. API documentation ─────────────────────────────────────────────────
  app.use(
    `${config.apiPrefix}/docs`,
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      customSiteTitle: 'PayFlux API',
      swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
    }),
  );
  app.get(`${config.apiPrefix}/openapi.json`, (_req, res) => res.json(swaggerSpec));

  // ── 9. Versioned routes. The version lives in the path so a breaking
  //       change can ship as /v2 while /v1 keeps serving existing merchants. ─
  app.use(`${config.apiPrefix}/v1`, v1Routes);

  // Root descriptor — useful for smoke tests and service discovery.
  app.get('/', (_req, res) => res.json({
    service: 'payflux-api',
    version: '1.0.0',
    environment: config.env,
    documentation: `${config.apiPrefix}/docs`,
    health: '/health',
  }));

  // ── 10. Unmatched routes ─────────────────────────────────────────────────
  app.use(middlewares.notFoundHandler);

  // ── 11. Error handling. Releasing the idempotency claim runs *before* the
  //        response is written, so a client retrying after a 500 is allowed to
  //        actually execute rather than replaying the failure. ──────────────
  app.use(middlewares.releaseIdempotencyOnError);
  app.use(middlewares.errorHandler);

  return app;
}

module.exports = createApp;
