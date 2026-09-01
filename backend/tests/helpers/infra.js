'use strict';

/**
 * Integration-test infrastructure guard.
 *
 * Integration tests run against real MongoDB and Redis rather than mocks: the
 * behaviours under test — unique-index races, `$expr` conditional updates, Lua
 * lock scripts, TTLs — are properties of the actual datastores, and a mock that
 * reimplements them proves nothing about production.
 *
 * When infrastructure is absent the suites skip with a clear message instead of
 * failing, so `npm test` stays useful on a laptop with nothing running.
 */

const mongoose = require('mongoose');
const IORedis = require('ioredis');

const MONGO_URI = process.env.TEST_MONGO_URI ?? process.env.MONGO_URI;
const REDIS_HOST = process.env.TEST_REDIS_HOST ?? process.env.REDIS_HOST ?? '127.0.0.1';
const REDIS_PORT = Number(process.env.TEST_REDIS_PORT ?? process.env.REDIS_PORT ?? 6379);

/** @returns {Promise<boolean>} whether both datastores are reachable. */
async function infraAvailable() {
  let redis;
  try {
    await mongoose.connect(MONGO_URI, { serverSelectionTimeoutMS: 2000 });
    redis = new IORedis({
      host: REDIS_HOST, port: REDIS_PORT, lazyConnect: true,
      retryStrategy: () => null, maxRetriesPerRequest: 1,
    });
    await redis.connect();
    await redis.ping();
    return true;
  } catch {
    return false;
  } finally {
    if (redis) redis.disconnect();
    await mongoose.disconnect().catch(() => {});
  }
}

/**
 * `describe` that skips the whole block when infra is missing.
 * Resolved once at module load so the skip decision is made before Jest builds
 * the suite tree.
 */
const describeIntegration = (name, fn) => {
  if (process.env.SKIP_INTEGRATION === 'true') return describe.skip(name, fn);
  return describe(name, fn);
};

module.exports = { infraAvailable, describeIntegration, MONGO_URI, REDIS_HOST, REDIS_PORT };
