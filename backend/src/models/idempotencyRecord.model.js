'use strict';

const { Schema, model } = require('mongoose');
const { IDEMPOTENCY_STATE } = require('../constants');

/**
 * Durable mirror of the Redis idempotency cache.
 *
 * Redis is the fast path and holds the authoritative in-flight lock, but it is
 * a cache: an eviction or a `FLUSHALL` would otherwise turn a client's safe
 * retry into a second charge. This collection is the fallback of record, and
 * the unique index is the last line of defence against a duplicate write even
 * if Redis is entirely unavailable.
 */
const idempotencyRecordSchema = new Schema(
  {
    key: { type: String, required: true },
    merchant: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true },
    endpoint: { type: String, required: true },   // 'POST /api/v1/payments'

    /** SHA-256 of the canonicalised request body; detects key reuse. */
    requestFingerprint: { type: String, required: true },

    state: {
      type: String,
      enum: Object.values(IDEMPOTENCY_STATE),
      default: IDEMPOTENCY_STATE.IN_FLIGHT,
      index: true,
    },
    responseStatus: { type: Number, default: null },
    responseBody: { type: Schema.Types.Mixed, default: null },
    resourceId: { type: String, default: null },

    correlationId: { type: String, default: null },
    completedAt: { type: Date, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true, toJSON: { transform: (_d, ret) => { delete ret.__v; return ret; } } },
);

// The structural uniqueness guarantee: one record per (merchant, endpoint, key).
idempotencyRecordSchema.index({ merchant: 1, endpoint: 1, key: 1 }, { unique: true });
// Mongo's TTL monitor reclaims expired records; matches the Redis TTL.
idempotencyRecordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = model('IdempotencyRecord', idempotencyRecordSchema);
