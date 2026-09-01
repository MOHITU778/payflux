'use strict';

const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis').default ?? require('rate-limit-redis');
const redis = require('../config/redis');
const config = require('../config');
const logger = require('../config/logger');
const { failure } = require('../utils/apiResponse');

/**
 * Distributed rate limiting.
 *
 * The counter lives in Redis, not in process memory. With N API replicas an
 * in-memory limiter would let a client through N × limit times — the limit
 * would silently scale with the deployment, which is the opposite of what a
 * limit is for.
 *
 * Limits are keyed by the authenticated principal where one exists, and by IP
 * otherwise. Keying purely by IP would punish every customer behind a shared
 * corporate NAT for one noisy neighbour.
 */

function buildStore(prefix) {
  const client = redis.getClient('client');
  return new RedisStore({
    prefix: `payflux:rl:${prefix}:`,
    // rate-limit-redis speaks the raw command interface.
    sendCommand: (...args) => client.call(...args),
  });
}

function keyGenerator(req) {
  if (req.merchant?.merchantId) return `m:${req.merchant.merchantId}`;
  if (req.user?.id) return `u:${req.user.id}`;
  return `ip:${req.ip}`;
}

function handler(req, res) {
  const retryAfter = Math.ceil((req.rateLimit?.resetTime - Date.now()) / 1000) || 60;
  res.set('Retry-After', String(retryAfter));
  logger.warn('rate limit exceeded', {
    key: keyGenerator(req), path: req.path, limit: req.rateLimit?.limit,
  });
  return failure(res, {
    status: 429,
    code: 'RATE_LIMITED',
    message: 'Too many requests — please retry later',
    details: { retryAfterSeconds: retryAfter },
  });
}

function createLimiter({ windowMs, max, prefix }) {
  return rateLimit({
    windowMs,
    max,
    store: buildStore(prefix),
    keyGenerator,
    handler,
    standardHeaders: true,   // RateLimit-* headers, so clients can self-throttle
    legacyHeaders: false,
    // A Redis outage must not lock everyone out; fall open and alert instead.
    skip: () => redis.getClient('client').status !== 'ready',
  });
}

module.exports = {
  /** Broad limit across the whole API. */
  global: () => createLimiter({ ...config.security.rateLimit, prefix: 'global' }),

  /**
   * Tighter limit on money-moving endpoints. A merchant legitimately creating
   * 60 payments a minute is normal; 600 is either a bug or an attack.
   */
  payments: () => createLimiter({ ...config.security.paymentRateLimit, prefix: 'pay' }),

  /**
   * Very tight limit on authentication, which is the endpoint an attacker
   * actually targets. Keyed by IP because there is no principal yet.
   */
  auth: () => rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    store: buildStore('auth'),
    keyGenerator: (req) => `ip:${req.ip}:${String(req.body?.email ?? '').toLowerCase()}`,
    handler,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests: true, // only failed attempts count toward the limit
  }),

  createLimiter,
};
