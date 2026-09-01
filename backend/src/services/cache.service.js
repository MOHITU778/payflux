'use strict';

const redis = require('../config/redis');
const logger = require('../config/logger');

/**
 * Read-through cache with stampede protection.
 *
 * Every method degrades gracefully: if Redis is down, `get` returns null and
 * `wrap` falls through to the loader. A cache outage must slow the system
 * down, never take it down.
 */
class CacheService {
  constructor({ client } = {}) {
    this.client = client ?? redis.getClient('client');
    this.log = logger.child({ component: 'cache' });
    this.prefix = 'payflux:cache:';
  }

  key(namespace, id) {
    return `${this.prefix}${namespace}:${id}`;
  }

  async get(namespace, id) {
    try {
      const raw = await this.client.get(this.key(namespace, id));
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      this.log.warn('cache read failed, falling through', { namespace, error: err.message });
      return null;
    }
  }

  async set(namespace, id, value, ttlSeconds = 300) {
    try {
      await this.client.set(this.key(namespace, id), JSON.stringify(value), 'EX', ttlSeconds);
      return true;
    } catch (err) {
      this.log.warn('cache write failed', { namespace, error: err.message });
      return false;
    }
  }

  async del(namespace, id) {
    try {
      return await this.client.del(this.key(namespace, id));
    } catch (err) {
      this.log.warn('cache delete failed', { namespace, error: err.message });
      return 0;
    }
  }

  /**
   * Invalidate a whole namespace.
   *
   * Uses SCAN, never KEYS: `KEYS pattern` is O(N) over the entire keyspace and
   * blocks the single-threaded Redis server for the duration — on a large
   * instance that is a multi-second stall for every other client.
   */
  async invalidateNamespace(namespace) {
    const pattern = `${this.prefix}${namespace}:*`;
    let cursor = '0';
    let removed = 0;
    do {
      const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
      cursor = next;
      if (keys.length) removed += await this.client.del(...keys);
    } while (cursor !== '0');
    this.log.debug('namespace invalidated', { namespace, removed });
    return removed;
  }

  /**
   * Read-through with single-flight.
   *
   * On a miss, one caller wins a short-lived `SET NX` lock and runs the loader;
   * the others poll briefly for the populated value instead of all hammering
   * the database. This is what stops a hot key expiring under load from
   * turning into a cache stampede that saturates Mongo.
   *
   * @param {string} namespace
   * @param {string} id
   * @param {() => Promise<T>} loader
   * @param {number} ttlSeconds
   * @returns {Promise<T>}
   * @template T
   */
  async wrap(namespace, id, loader, ttlSeconds = 300) {
    const cached = await this.get(namespace, id);
    if (cached !== null) return cached;

    const lockKey = `${this.key(namespace, id)}:load`;
    let won = false;
    try {
      won = (await this.client.set(lockKey, '1', 'PX', 5000, 'NX')) === 'OK';
    } catch {
      won = true; // Redis unavailable — every caller just loads directly.
    }

    if (!won) {
      // Brief poll: the winner usually populates within a few milliseconds.
      for (let i = 0; i < 10; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        const value = await this.get(namespace, id);
        if (value !== null) return value;
      }
      return loader(); // Winner is slow or died — do the work ourselves.
    }

    try {
      const value = await loader();
      if (value !== null && value !== undefined) await this.set(namespace, id, value, ttlSeconds);
      return value;
    } finally {
      await this.client.del(lockKey).catch(() => {});
    }
  }

  /** Fixed-window counter, used by velocity checks. Returns the new count. */
  async incrementWindow(namespace, id, windowSeconds) {
    const key = `${this.prefix}counter:${namespace}:${id}`;
    const [[, count]] = await this.client
      .multi()
      .incr(key)
      .expire(key, windowSeconds, 'NX') // set the TTL only on first increment
      .exec();
    return count;
  }

  async getWindowCount(namespace, id) {
    const raw = await this.client.get(`${this.prefix}counter:${namespace}:${id}`);
    return Number(raw ?? 0);
  }
}

module.exports = new CacheService();
module.exports.CacheService = CacheService;
