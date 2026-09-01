'use strict';

const mongoose = require('mongoose');
const config = require('../config');
const logger = require('../config/logger');
const { failure } = require('../utils/apiResponse');
const { AppError, ValidationError, ConflictError, NotFoundError } = require('../errors');

/**
 * Centralised error handling.
 *
 * Exactly one place converts a thrown value into an HTTP response. That is what
 * makes the API's error contract uniform — and it is the only way to guarantee
 * that an unexpected internal error never leaks a stack trace, a Mongo index
 * name, or a driver message to a caller.
 *
 * Errors fall into two classes:
 *   • **Operational** — an `AppError` we threw on purpose. Its message is
 *     already client-safe and is returned as-is.
 *   • **Programmer** — anything else. Logged in full at `error` level with the
 *     stack, and returned to the caller as a bare 500.
 */

/** Map well-known third-party errors onto our own taxonomy. */
function normalize(err) {
  if (err instanceof AppError) return err;

  // Mongoose schema validation (a model-level rule the DTO did not catch).
  if (err instanceof mongoose.Error.ValidationError) {
    const details = Object.values(err.errors).map((detail) => ({
      field: detail.path,
      message: detail.message,
      type: detail.kind,
    }));
    return new ValidationError('Document validation failed', details);
  }

  // A malformed ObjectId in a path parameter is a 404, not a 500 — the caller
  // asked for something that cannot exist.
  if (err instanceof mongoose.Error.CastError) {
    return new NotFoundError('Resource', 'INVALID_RESOURCE_ID');
  }

  // Duplicate key. The raw error names the index and the offending value, so
  // it is rewritten rather than passed through.
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern ?? {}).join(', ') || 'unique field';
    return new ConflictError(`A record with this ${field} already exists`, { field });
  }

  // Body-parser rejected malformed JSON.
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError && 'body' in err) {
    return new ValidationError('Request body is not valid JSON');
  }
  if (err.type === 'entity.too.large') {
    return new AppError('Request body exceeds the size limit', {
      status: 413, code: 'PAYLOAD_TOO_LARGE',
    });
  }

  return null; // genuinely unexpected
}

/** Terminal error middleware. Must be mounted last, and must take four args. */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const normalized = normalize(err);

  if (normalized) {
    // Operational: expected, logged at a proportionate level.
    const level = normalized.status >= 500 ? 'error' : 'warn';
    logger[level]('request failed', {
      code: normalized.code,
      status: normalized.status,
      message: normalized.message,
      path: req.originalUrl,
      method: req.method,
      details: normalized.details,
      ...(normalized.status >= 500 ? { stack: normalized.stack } : {}),
    });

    if (normalized.retryable) res.set('x-retryable', 'true');
    if (normalized.code === 'RATE_LIMITED' && normalized.details?.retryAfterSeconds) {
      res.set('Retry-After', String(normalized.details.retryAfterSeconds));
    }

    return failure(res, {
      status: normalized.status,
      code: normalized.code,
      message: normalized.message,
      details: normalized.details,
    });
  }

  // Programmer error: log everything, disclose nothing.
  logger.error('unhandled error', {
    message: err.message,
    stack: err.stack,
    path: req.originalUrl,
    method: req.method,
    name: err.name,
  });

  return failure(res, {
    status: 500,
    code: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
    // The stack is exposed in development only — never in production, where it
    // would hand an attacker a map of the codebase.
    details: config.isProduction ? undefined : { message: err.message, stack: err.stack?.split('\n').slice(0, 5) },
  });
}

/** 404 for unmatched routes. Mounted after all routers, before `errorHandler`. */
function notFoundHandler(req, _res, next) {
  return next(new NotFoundError(`Route ${req.method} ${req.originalUrl}`, 'ROUTE_NOT_FOUND'));
}

module.exports = { errorHandler, notFoundHandler, normalize };
