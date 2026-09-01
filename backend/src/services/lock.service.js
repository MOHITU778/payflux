'use strict';

const crypto = require('node:crypto');
const redis = require('../config/redis');
const config = require('../config');
const logger = require('../config/logger');
const metrics = require('../config/metrics');
const { LockAcquisitionError } = require('../errors');
const { sleep } = require('../utils/backoff');

/**
 * Distributed mutual exclusion over Redis (Redlock single-instance variant).
 *
 * ── Why a lock at all ──────────────────────────────────────────────────────
 * The API runs N replicas. Two retries of the same payment can land on two
 * pods simultaneously; process-level mutexes are useless across processes. The
 * lock serialises the critical section — read payment, decide, write — so only
 * one replica may act on a given payment at a time.
 *
 * ── Correctness properties ─────────────────────────────────────────────────
 * 1. Mutual exclusion — `SET key token NX PX ttl` is atomic; exactly one
 *    caller can create the key.
 * 2. Deadlock freedom — every lock carries a TTL, so a crashed holder's lock
 *    expires rather than blocking the resource forever.
 * 3. Safe release — the unlock script compares the stored token to the
 *    caller's before deleting. Without this compare-and-delete, a holder whose
 *    lock had already expired could delete a *different* caller's lock, and
 *    mutual exclusion would silently break. This is the single most common bug
 *    in hand-rolled Redis locks.
 * 4. Extendable — a long critical section can renew its own lease, but only
 *    while it still owns it.
 *
 * ── Honest limitation ──────────────────────────────────────────────────────
 * A Redis lock is an *optimisation*, not an absolute guarantee: under a
 * primary failover with unreplicated writes, or a long GC pause that outlasts
 * the TTL, two holders are possible. Every critical section it protects is
 * therefore *also* guarded by a database-level invariant — the CAS status
 * filter on payments, the unique index on journals — so a lost lock degrades
 * to a rejected write rather than a double charge.
 */

/** Compare-and-delete: release only if we still hold the lock. */
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end`;

/** Compare-and-extend: renew the lease only if we still hold it. */
const EXTEND_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
  return 0
end`;

class LockService {
  constructor({ client, options = {} } = {}) {
    this.client = client ?? redis.getClient('client');
    this.options = { ...config.lock, ...options };
    this.log = logger.child({ component: 'lock' });
    this.defineCommands();
  }

  /**
   * Register the Lua scripts as ioredis custom commands.
   * ioredis uses EVALSHA with an automatic EVAL fallback, so the script body
   * crosses the wire once per Redis process rather than once per unlock.
   */
  defineCommands() {
    if (!this.client.releaseLock) {
      this.client.defineCommand('releaseLock', { numberOfKeys: 1, lua: RELEASE_SCRIPT });
    }
    if (!this.client.extendLock) {
      this.client.defineCommand('extendLock', { numberOfKeys: 1, lua: EXTEND_SCRIPT });
    }
  }

  static key(resource) {
    return `payflux:lock:${resource}`;
  }

  /**
   * Try once to take the lock.
   * @returns {Promise<{token: string, key: string}|null>} null if already held.
   */
  async tryAcquire(resource, ttlMs = this.options.ttlMs) {
    const key = LockService.key(resource);
    // A cryptographically random token — guessable tokens would let one caller
    // release another's lock.
    const token = crypto.randomBytes(16).toString('hex');
    const result = await this.client.set(key, token, 'PX', ttlMs, 'NX');
    return result === 'OK' ? { key, token, resource, ttlMs } : null;
  }

  /**
   * Acquire with bounded retries and jittered backoff.
   *
   * Jitter matters here: without it, several replicas waiting on the same
   * payment wake at the same millisecond and collide again, converting
   * contention into a retry storm.
   *
   * @throws {LockAcquisitionError} when every attempt is exhausted.
   */
  async acquire(resource, { ttlMs = this.options.ttlMs, retryCount = this.options.retryCount,
    retryDelayMs = this.options.retryDelayMs } = {}) {
    const started = Date.now();

    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
      const lock = await this.tryAcquire(resource, ttlMs);
      if (lock) {
        const waited = (Date.now() - started) / 1000;
        metrics.lockAcquisitions.inc({ resource: labelOf(resource), outcome: 'acquired' });
        metrics.lockWaitDuration.observe({ resource: labelOf(resource) }, waited);
        if (attempt > 0) this.log.debug('lock acquired after contention', { resource, attempt });
        return lock;
      }
      if (attempt === retryCount) break;
      await sleep(retryDelayMs + Math.floor(Math.random() * this.options.retryJitterMs));
    }

    metrics.lockAcquisitions.inc({ resource: labelOf(resource), outcome: 'timeout' });
    this.log.warn('lock acquisition failed', { resource, retryCount, waitedMs: Date.now() - started });
    throw new LockAcquisitionError(resource);
  }

  /** @returns {Promise<boolean>} true if this call actually released the lock. */
  async release(lock) {
    if (!lock?.key) return false;
    const released = await this.client.releaseLock(lock.key, lock.token);
    if (!released) {
      // The lock expired mid-section and possibly belongs to someone else now.
      // Loud, because it means the critical section outran its TTL.
      this.log.warn('lock already expired before release', { resource: lock.resource });
      metrics.lockAcquisitions.inc({ resource: labelOf(lock.resource), outcome: 'lost' });
    }
    return Boolean(released);
  }

  /** Renew the lease. Returns false if ownership was already lost. */
  async extend(lock, ttlMs = this.options.ttlMs) {
    const extended = await this.client.extendLock(lock.key, lock.token, ttlMs);
    return Boolean(extended);
  }

  /**
   * Run `fn` while holding the lock, releasing it on every exit path.
   *
   * This is the only API callers should normally use — a manual
   * acquire/release pair leaks the lock the first time someone adds an early
   * `return` or an exception path to the body.
   *
   * @param {string} resource        Logical resource, e.g. `payment:pay_abc`.
   * @param {(lock) => Promise<T>} fn Critical section.
   * @returns {Promise<T>}
   * @template T
   */
  async withLock(resource, fn, options = {}) {
    const lock = await this.acquire(resource, options);
    // Auto-renew for sections that may legitimately outlive the TTL.
    const heartbeat = options.autoExtend
      ? setInterval(() => {
        this.extend(lock, options.ttlMs ?? this.options.ttlMs).catch((err) =>
          this.log.error('lock extend failed', { resource, error: err.message }));
      }, Math.floor((options.ttlMs ?? this.options.ttlMs) / 3))
      : null;

    try {
      return await fn(lock);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      await this.release(lock).catch((err) =>
        this.log.error('lock release failed', { resource, error: err.message }));
    }
  }
}

/**
 * Collapse a resource id into a bounded metric label.
 * `payment:pay_abc123` → `payment`. Labelling by the full id would create one
 * time series per payment and destroy the metrics backend.
 */
function labelOf(resource) {
  return String(resource).split(':')[0];
}

module.exports = new LockService();
module.exports.LockService = LockService;
module.exports.RELEASE_SCRIPT = RELEASE_SCRIPT;
