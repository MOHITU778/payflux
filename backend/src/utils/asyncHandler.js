'use strict';

/**
 * Wrap an async Express handler so a rejected promise reaches the centralised
 * error middleware.
 *
 * Express 4 does not await handlers: an unhandled rejection inside one would
 * otherwise hang the request until the client times out, and crash the process
 * under Node's default unhandled-rejection policy.
 *
 * @param {(req, res, next) => Promise<unknown>} fn
 * @returns {(req, res, next) => void}
 */
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

module.exports = asyncHandler;
