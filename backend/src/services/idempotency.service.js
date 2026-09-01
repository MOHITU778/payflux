'use strict';

const redis = require('../config/redis');
const config = require('../config');
const logger = require('../config/logger');
const metrics = require('../config/metrics');
const { idempotencyRepository } = require('../repositories');
const { IDEMPOTENCY_STATE } = require('../constants');
const { IdempotencyConflictError, IdempotencyKeyReuseError } = require('../errors');
const { fingerprint } = require('../utils/crypto');

/**
 * Idempotent request processing.
 *
 * ── The problem ────────────────────────────────────────────────────────────
 * A client POSTs a payment. The response is lost to a timeout. The client
 * retries. Without idempotency the customer is charged twice — the single most
 * damaging failure mode a payment gateway has.
 *
 * ── The contract ───────────────────────────────────────────────────────────
 * Every mutating payment request carries an `Idempotency-Key`. For a given
 * (merchant, endpoint, key):
 *   • first request       → executes, response is stored
 *   • retry, same body    → the stored response is replayed verbatim
 *   • retry while in flight → 409, retryable; the client backs off
 *   • same key, different body → 422; replaying would be a lie
 *
 * ── Two-tier storage ───────────────────────────────────────────────────────
 * Redis is the fast path and holds the in-flight claim (`SET NX` with a TTL,
 * so a crashed request cannot wedge a key permanently). MongoDB holds the
 * durable record with a unique index. Redis alone is not enough: it is a
 * cache, and an eviction would turn a safe retry into a second charge. Mongo
 * alone would put a write on the hot path of every request. Together, Redis
 * absorbs the reads and Mongo provides the guarantee.
 */
class IdempotencyService {
  constructor({ client, repository, ttlSeconds } = {}) {
    this.client = client ?? redis.getClient('client');
    this.repository = repository ?? idempotencyRepository;
    this.ttlSeconds = ttlSeconds ?? config.idempotency.ttlSeconds;
    this.log = logger.child({ component: 'idempotency' });
  }

  static redisKey(merchantId, endpoint, key) {
    return `payflux:idem:${merchantId}:${endpoint}:${key}`;
  }

  /**
   * Attempt to claim a key.
   *
   * @returns {Promise<
   *   {status:'CLAIMED'} |
   *   {status:'REPLAY', response:{status:number, body:object}} >}
   * @throws {IdempotencyConflictError}  another request holds the key
   * @throws {IdempotencyKeyReuseError}  key reused with a different payload
   */
  async begin({ key, merchantId, merchantObjectId, endpoint, requestBody, correlationId }) {
    const redisKey = IdempotencyService.redisKey(merchantId, endpoint, key);
    const requestFingerprint = fingerprint(requestBody ?? {});

    // ── Fast path: is there already a record in Redis? ──────────────────
    const cached = await this.readRedis(redisKey);
    if (cached) return this.interpret(cached, requestFingerprint, key, endpoint);

    // ── Claim in Redis. SET NX is atomic, so exactly one concurrent
    //    request wins even across replicas. ─────────────────────────────
    const claim = {
      state: IDEMPOTENCY_STATE.IN_FLIGHT,
      requestFingerprint,
      correlationId,
      startedAt: Date.now(),
    };
    const won = await this.client
      .set(redisKey, JSON.stringify(claim), 'EX', this.ttlSeconds, 'NX')
      .catch((err) => {
        // Redis is down. Fall through to Mongo, which still guarantees
        // correctness — we just lose the latency benefit.
        this.log.error('redis unavailable for idempotency claim', { error: err.message });
        return null;
      });

    if (won !== 'OK') {
      const raced = await this.readRedis(redisKey);
      if (raced) return this.interpret(raced, requestFingerprint, key, endpoint);
    }

    // ── Durable claim. The unique index is the real guarantee. ──────────
    const { claimed, record } = await this.repository.claim({
      key,
      merchant: merchantObjectId,
      endpoint,
      requestFingerprint,
      correlationId,
      ttlSeconds: this.ttlSeconds,
    });

    if (claimed) return { status: 'CLAIMED', requestFingerprint };

    // Mongo already had the key — Redis had been evicted or never written.
    // Re-warm the cache so subsequent retries take the fast path.
    if (record?.state === IDEMPOTENCY_STATE.COMPLETED) {
      await this.cacheCompletion(redisKey, record);
    }
    return this.interpret(
      {
        state: record?.state,
        requestFingerprint: record?.requestFingerprint,
        responseStatus: record?.responseStatus,
        responseBody: record?.responseBody,
      },
      requestFingerprint,
      key,
      endpoint,
    );
  }

  /** Decide what an existing record means for the incoming request. */
  interpret(record, requestFingerprint, key, endpoint) {
    // A matching key with a different body is a client bug (or an attack).
    // Replaying the stored response would confirm a payment the caller never
    // actually asked for, so we refuse.
    if (record.requestFingerprint && record.requestFingerprint !== requestFingerprint) {
      throw new IdempotencyKeyReuseError(key);
    }
    if (record.state === IDEMPOTENCY_STATE.COMPLETED) {
      metrics.idempotencyHits.inc({ endpoint });
      this.log.info('replaying stored idempotent response', { key, endpoint });
      return {
        status: 'REPLAY',
        response: { status: record.responseStatus, body: record.responseBody },
      };
    }
    throw new IdempotencyConflictError(key);
  }

  /**
   * Store the outcome so future retries replay it.
   * Redis first (cheap, and what the next retry will read), then Mongo.
   */
  async complete({ key, merchantId, merchantObjectId, endpoint }, { status, body, resourceId }) {
    const redisKey = IdempotencyService.redisKey(merchantId, endpoint, key);
    const record = {
      state: IDEMPOTENCY_STATE.COMPLETED,
      requestFingerprint: await this.fingerprintOf(redisKey),
      responseStatus: status,
      responseBody: body,
      resourceId,
      completedAt: Date.now(),
    };

    await this.client.set(redisKey, JSON.stringify(record), 'EX', this.ttlSeconds)
      .catch((err) => this.log.error('failed to cache idempotent response', { error: err.message }));

    await this.repository.complete(
      { key, merchant: merchantObjectId, endpoint },
      { responseStatus: status, responseBody: body, resourceId },
    );
  }

  /**
   * Release a claim whose request failed without producing a durable result.
   *
   * Only *unexpected* failures release the key. A deliberate business rejection
   * (fraud block, invalid state) is a real, reproducible answer and is stored
   * like any other response — otherwise a client could retry a blocked payment
   * indefinitely and eventually slip through on a scoring boundary.
   */
  async release({ key, merchantId, merchantObjectId, endpoint }) {
    const redisKey = IdempotencyService.redisKey(merchantId, endpoint, key);
    await this.client.del(redisKey).catch(() => {});
    await this.repository.release({ key, merchant: merchantObjectId, endpoint }).catch((err) =>
      this.log.error('failed to release idempotency claim', { key, error: err.message }));
  }

  async readRedis(redisKey) {
    try {
      const raw = await this.client.get(redisKey);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      this.log.warn('idempotency cache read failed', { error: err.message });
      return null;
    }
  }

  async fingerprintOf(redisKey) {
    const existing = await this.readRedis(redisKey);
    return existing?.requestFingerprint ?? null;
  }

  async cacheCompletion(redisKey, record) {
    await this.client
      .set(redisKey, JSON.stringify({
        state: IDEMPOTENCY_STATE.COMPLETED,
        requestFingerprint: record.requestFingerprint,
        responseStatus: record.responseStatus,
        responseBody: record.responseBody,
      }), 'EX', this.ttlSeconds)
      .catch(() => {});
  }
}

module.exports = new IdempotencyService();
module.exports.IdempotencyService = IdempotencyService;
