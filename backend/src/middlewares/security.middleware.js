'use strict';

const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const config = require('../config');
const logger = require('../config/logger');
const { ForbiddenError } = require('../errors');

/**
 * Security middleware stack.
 *
 * Applied in a deliberate order: headers first (they must be present even on an
 * error response), then CORS (a rejected origin should never reach a handler),
 * then payload defences.
 */

/**
 * Recursively strip keys that MongoDB would interpret as operators.
 *
 * NoSQL injection works by smuggling an object where a scalar is expected:
 * `{"email": {"$gt": ""}}` matches every user. Express 5 makes `req.query` a
 * getter-only property, so mutating in place is the portable approach — and
 * dropping the keys outright is safer than replacing `$` with `_`, which can
 * silently corrupt legitimate data.
 */
function sanitizeObject(value, path = '', removed = []) {
  if (value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    value.forEach((entry, index) => sanitizeObject(entry, `${path}[${index}]`, removed));
    return value;
  }

  for (const key of Object.keys(value)) {
    // `$` starts an operator; `.` allows dotted-path traversal into subdocuments.
    if (key.startsWith('$') || key.includes('.')) {
      delete value[key];
      removed.push(`${path}${path ? '.' : ''}${key}`);
      continue;
    }
    sanitizeObject(value[key], `${path}${path ? '.' : ''}${key}`, removed);
  }
  return value;
}

function mongoSanitize(req, _res, next) {
  const removed = [];
  sanitizeObject(req.body, 'body', removed);
  sanitizeObject(req.params, 'params', removed);
  // `req.query` may be a getter; sanitize the object it returns in place.
  if (req.query && typeof req.query === 'object') sanitizeObject(req.query, 'query', removed);

  if (removed.length) {
    // Worth an alert: legitimate clients never send `$`-prefixed keys.
    logger.warn('stripped potential NoSQL operator injection', {
      fields: removed, ip: req.ip, path: req.path,
    });
  }
  return next();
}

/** CORS with an explicit allow-list. */
function buildCors() {
  return cors({
    origin(origin, callback) {
      // No Origin header: server-to-server, curl, mobile SDK. Not a browser
      // request, so the same-origin policy is not what protects it — the API
      // key / bearer token is.
      if (!origin) return callback(null, true);
      if (config.security.corsOrigins.includes(origin)) return callback(null, true);
      logger.warn('blocked cross-origin request', { origin });
      return callback(new ForbiddenError(`Origin ${origin} is not permitted`, 'CORS_REJECTED'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type', 'Authorization', 'Idempotency-Key',
      'X-Correlation-Id', 'X-Api-Key', config.webhook.signatureHeader,
    ],
    // Clients need to read these to correlate and to page through lists.
    exposedHeaders: ['X-Correlation-Id', 'X-Request-Id', 'RateLimit-Remaining', 'Retry-After'],
    maxAge: 86400,
  });
}

/** Header hardening. */
function buildHelmet() {
  return helmet({
    // The API serves JSON, not markup, so a restrictive CSP costs nothing.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"], // Swagger UI needs inline styles
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],       // no clickjacking of the console
        objectSrc: ["'none'"],
      },
    },
    // Force HTTPS for a year, including subdomains.
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginResourcePolicy: { policy: 'same-site' },
    // Do not advertise the stack we run.
    hidePoweredBy: true,
  });
}

module.exports = {
  helmet: buildHelmet,
  cors: buildCors,
  mongoSanitize,
  sanitizeObject,
  compression: () => compression({ threshold: 1024 }),
};
