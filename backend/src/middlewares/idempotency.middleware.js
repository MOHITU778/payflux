'use strict';

const idempotencyService = require('../services/idempotency.service');
const logger = require('../config/logger');
const asyncHandler = require('../utils/asyncHandler');
const requestContext = require('../utils/requestContext');
const { ValidationError, AppError } = require('../errors');

/**
 * Idempotency-Key enforcement.
 *
 * Implemented as middleware rather than inside each service so the guarantee is
 * uniform: any route that mounts it is idempotent, and a new endpoint cannot
 * accidentally ship without the protection.
 *
 * ── How the response is captured ───────────────────────────────────────────
 * `res.json` is wrapped so the outgoing body is intercepted at the moment it
 * is sent. That is the only place the *final* response is known — a controller
 * may transform it, and an error middleware may replace it entirely.
 *
 * ── What gets stored ───────────────────────────────────────────────────────
 * Successes (2xx) and deliberate business rejections (4xx from an `AppError`)
 * are both stored: both are reproducible answers, and replaying them is
 * correct. Unexpected 5xx errors release the key instead, so the client's
 * retry is allowed to actually retry rather than being handed a stale failure
 * for the next 24 hours.
 */

/**
 * @param {object} [options]
 * @param {boolean} [options.required=true]  Reject requests without the header.
 */
function idempotency({ required = true } = {}) {
  return asyncHandler(async (req, res, next) => {
    const key = req.get('idempotency-key');

    if (!key) {
      if (!required) return next();
      throw new ValidationError('Idempotency-Key header is required for this operation', [
        { field: 'headers.idempotency-key', message: 'header is required', type: 'any.required' },
      ]);
    }

    // Bound the key: it becomes part of a Redis key and a Mongo index entry.
    if (key.length < 8 || key.length > 255) {
      throw new ValidationError('Idempotency-Key must be between 8 and 255 characters', [
        { field: 'headers.idempotency-key', message: 'invalid length', type: 'string.length' },
      ]);
    }

    // Scoped per merchant and per endpoint: the same key on two different
    // endpoints is two independent operations, and one merchant's key must
    // never collide with another's.
    const endpoint = `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`;
    const scope = {
      key,
      merchantId: req.merchant?.merchantId ?? 'platform',
      merchantObjectId: req.merchant?._id ?? null,
      endpoint,
    };

    const outcome = await idempotencyService.begin({
      ...scope,
      requestBody: req.body,
      correlationId: requestContext.get('correlationId'),
    });

    // A completed request with this key already exists — replay it verbatim.
    if (outcome.status === 'REPLAY') {
      res.set('x-idempotent-replay', 'true');
      logger.info('idempotent replay served', { key, endpoint });
      return res.status(outcome.response.status).json(outcome.response.body);
    }

    req.idempotency = scope;
    res.set('x-idempotency-key', key);

    // ── Capture the outgoing response ─────────────────────────────────────
    const originalJson = res.json.bind(res);
    let settled = false;

    res.json = (body) => {
      if (settled) return originalJson(body);
      settled = true;

      const status = res.statusCode;
      const reproducible = status < 500;

      // Persist (or release) without blocking the response to the client.
      const persist = reproducible
        ? idempotencyService.complete(scope, {
          status,
          body,
          resourceId: body?.data?.paymentId ?? body?.data?.refundId ?? null,
        })
        : idempotencyService.release(scope);

      persist.catch((err) =>
        logger.error('failed to persist idempotency outcome', { key, endpoint, error: err.message }));

      return originalJson(body);
    };

    // A request that dies without ever calling res.json (socket hang-up,
    // process kill) must not leave the key claimed forever.
    res.on('close', () => {
      if (settled || res.writableEnded) return;
      idempotencyService.release(scope).catch(() => {});
      logger.warn('released idempotency claim on aborted request', { key, endpoint });
    });

    return next();
  });
}

/**
 * Release the claim when a handler throws an unexpected error.
 * Mounted before the error handler so the key is freed before the client sees
 * the 500 and retries.
 */
function releaseIdempotencyOnError(err, req, _res, next) {
  const isUnexpected = !(err instanceof AppError) || err.status >= 500;
  if (req.idempotency && isUnexpected) {
    idempotencyService.release(req.idempotency).catch(() => {});
  }
  return next(err);
}

module.exports = { idempotency, releaseIdempotencyOnError };
