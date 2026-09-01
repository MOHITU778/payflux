'use strict';

const winston = require('winston');
const config = require('./index');
const requestContext = require('../utils/requestContext');

/**
 * Structured logging.
 *
 * Production emits newline-delimited JSON so a log shipper (Fluent Bit → ELK /
 * Loki) can index every field. Development pretty-prints the same records.
 * Correlation and request ids are injected by a format rather than by callers,
 * so a log line is traceable end-to-end even when the author forgot to add it.
 */

/** Field names that must never reach a log sink in cleartext. */
const REDACTED_KEYS = new Set([
  'password', 'passwordHash', 'token', 'accessToken', 'refreshToken',
  'authorization', 'apiSecret', 'secret', 'signature', 'cardNumber', 'cvv', 'pin',
]);

/** Recursively mask sensitive values; depth-capped to stay cheap on hot paths. */
function redact(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : redact(entry, depth + 1);
  }
  return out;
}

/** Merge the ambient AsyncLocalStorage context into every record. */
const withContext = winston.format((info) => {
  const ctx = requestContext.getContext();
  if (ctx.correlationId) info.correlationId = ctx.correlationId;
  if (ctx.requestId) info.requestId = ctx.requestId;
  if (ctx.userId) info.userId = ctx.userId;
  if (ctx.merchantId) info.merchantId = ctx.merchantId;
  return info;
});

/**
 * Mask sensitive metadata in place.
 *
 * A winston format must return the *same* `info` object: winston carries the
 * level and the rendered message on symbol keys, and rebuilding the object
 * with a spread silently drops them, which breaks every downstream format.
 */
const RESERVED = new Set(['level', 'message', 'timestamp', 'stack']);
const redactFormat = winston.format((info) => {
  for (const key of Object.keys(info)) {
    if (RESERVED.has(key)) continue;
    info[key] = REDACTED_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : redact(info[key]);
  }
  return info;
});

const devFormat = winston.format.printf(({ level, message, timestamp, correlationId, stack, ...meta }) => {
  const scope = correlationId ? ` [${correlationId}]` : '';
  const rest = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} ${level}${scope}: ${message}${rest}${stack ? `\n${stack}` : ''}`;
});

const logger = winston.createLogger({
  level: config.log.level,
  defaultMeta: { service: 'payflux-api', env: config.env },
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    withContext(),
    redactFormat(),
    config.isProduction
      ? winston.format.json()
      : winston.format.combine(winston.format.colorize(), devFormat),
  ),
  transports: [
    new winston.transports.Console({
      // Never let a logging failure take down request handling.
      handleExceptions: false,
      silent: config.isTest && process.env.LOG_IN_TESTS !== 'true',
    }),
  ],
});

/**
 * Bind a logger to a subsystem so every record it emits carries `component`.
 * Uses winston's own child loggers, which share transports and formats.
 * @param {string} component  e.g. 'ledger', 'webhook-worker'.
 * @param {object} [meta]     Extra static fields.
 */
logger.forComponent = (component, meta = {}) => logger.child({ component, ...meta });

module.exports = logger;
