'use strict';

const logger = require('../config/logger');
const metrics = require('../config/metrics');

/** Endpoints that are too chatty (or too sensitive) to log per request. */
const SKIP_PATHS = new Set(['/health', '/health/live', '/health/ready', '/metrics']);

/** Query parameters that must never be written to a log line. */
const SENSITIVE_QUERY = new Set(['token', 'secret', 'apiSecret', 'password']);

function safeQuery(query) {
  const out = {};
  for (const [key, value] of Object.entries(query ?? {})) {
    out[key] = SENSITIVE_QUERY.has(key) ? '[REDACTED]' : value;
  }
  return out;
}

/**
 * Access logging and HTTP metrics.
 *
 * Metrics are labelled with the *route template* (`/api/v1/payments/:paymentId`)
 * rather than the concrete path. Labelling with the real URL would mint a new
 * Prometheus time series per payment id and blow up the metrics backend — the
 * single most common way a `/metrics` endpoint kills its own cluster.
 */
module.exports = function requestLogger(req, res, next) {
  if (SKIP_PATHS.has(req.path)) return next();

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - (req.startedAt ?? process.hrtime.bigint())) / 1e6;
    // `req.route` is only populated once Express has matched a handler; fall
    // back to the mount path for 404s so the label set stays bounded.
    const route = req.route ? `${req.baseUrl}${req.route.path}` : (req.baseUrl || 'unmatched');
    const labels = { method: req.method, route, status: String(res.statusCode) };

    metrics.httpRequestDuration.observe(labels, durationMs / 1000);
    metrics.httpRequestsTotal.inc(labels);

    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]('http request', {
      method: req.method,
      path: req.originalUrl.split('?')[0],
      route,
      status: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
      ip: req.ip,
      userAgent: req.get('user-agent'),
      query: safeQuery(req.query),
      userId: req.user?.id,
      merchantId: req.merchant?.merchantId,
      contentLength: res.get('content-length'),
    });
  });

  return next();
};
