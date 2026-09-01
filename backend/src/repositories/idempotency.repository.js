'use strict';

const BaseRepository = require('./base.repository');
const { IdempotencyRecord } = require('../models');
const { IDEMPOTENCY_STATE } = require('../constants');

class IdempotencyRepository extends BaseRepository {
  constructor() { super(IdempotencyRecord); }

  /**
   * Claim a key for execution.
   *
   * The unique (merchant, endpoint, key) index makes this a compare-and-set:
   * exactly one caller inserts, everyone else gets the duplicate-key error and
   * is told to read the existing record. Returns `{ claimed, record }` so the
   * middleware never has to interpret a driver error code.
   */
  async claim({ key, merchant, endpoint, requestFingerprint, correlationId, ttlSeconds }) {
    try {
      const doc = await IdempotencyRecord.create({
        key,
        merchant,
        endpoint,
        requestFingerprint,
        correlationId,
        state: IDEMPOTENCY_STATE.IN_FLIGHT,
        expiresAt: new Date(Date.now() + ttlSeconds * 1000),
      });
      return { claimed: true, record: doc.toObject() };
    } catch (err) {
      if (err.code === 11000) {
        const record = await this.findOne({ key, merchant, endpoint });
        return { claimed: false, record };
      }
      throw err;
    }
  }

  complete({ key, merchant, endpoint }, { responseStatus, responseBody, resourceId }) {
    return this.updateOne(
      { key, merchant, endpoint },
      {
        $set: {
          state: IDEMPOTENCY_STATE.COMPLETED,
          responseStatus,
          responseBody,
          resourceId,
          completedAt: new Date(),
        },
      },
    );
  }

  /**
   * Release a claim that failed before producing a durable result, so the
   * client's retry is allowed to execute rather than being told "in flight"
   * for the next 24 hours.
   */
  release({ key, merchant, endpoint }) {
    return this.deleteOne({ key, merchant, endpoint, state: IDEMPOTENCY_STATE.IN_FLIGHT });
  }
}

module.exports = new IdempotencyRepository();
module.exports.IdempotencyRepository = IdempotencyRepository;
