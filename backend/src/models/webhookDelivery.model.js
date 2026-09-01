'use strict';

const { Schema, model } = require('mongoose');
const { WEBHOOK_DELIVERY_STATUS, EVENT } = require('../constants');

/** One HTTP attempt, kept in full so support can answer "what did you send us?". */
const attemptSchema = new Schema(
  {
    attempt: { type: Number, required: true },
    at: { type: Date, default: Date.now },
    statusCode: { type: Number, default: null },
    durationMs: { type: Number, default: null },
    error: { type: String, default: null },
    // Truncated: a chatty endpoint must not be able to bloat our documents.
    responseBody: { type: String, default: null, maxlength: 2000 },
  },
  { _id: false },
);

/**
 * The outbox record for a single (event → endpoint) pair.
 *
 * Delivery follows the transactional-outbox pattern: the event is committed
 * here first, then dispatched by a worker. If the process dies between the two,
 * the retry scheduler finds the PENDING row and picks it back up — an event
 * cannot be silently lost because a pod was rescheduled mid-request.
 */
const webhookDeliverySchema = new Schema(
  {
    deliveryId: { type: String, required: true, unique: true },
    /** Stable across all retries, and echoed in the payload so receivers can dedupe. */
    eventId: { type: String, required: true, index: true },
    eventType: { type: String, enum: Object.values(EVENT), required: true, index: true },

    endpoint: { type: Schema.Types.ObjectId, ref: 'WebhookEndpoint', required: true, index: true },
    merchant: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true, index: true },
    url: { type: String, required: true },

    payload: { type: Schema.Types.Mixed, required: true },

    status: {
      type: String,
      enum: Object.values(WEBHOOK_DELIVERY_STATUS),
      default: WEBHOOK_DELIVERY_STATUS.PENDING,
      index: true,
    },
    attemptCount: { type: Number, default: 0 },
    maxAttempts: { type: Number, required: true },
    nextAttemptAt: { type: Date, default: Date.now, index: true },
    attempts: { type: [attemptSchema], default: [] },

    deliveredAt: { type: Date, default: null },
    deadLetteredAt: { type: Date, default: null },
    /** Set when an operator manually replays a dead-lettered delivery. */
    replayedFromDeliveryId: { type: String, default: null },
  },
  { timestamps: true, toJSON: { transform: (_d, ret) => { delete ret.__v; return ret; } } },
);

// One delivery per event per endpoint. This unique index is the structural
// guarantee against duplicate sends when a producer is retried.
webhookDeliverySchema.index({ eventId: 1, endpoint: 1 }, { unique: true });
// The retry sweeper's query: due, not yet terminal.
webhookDeliverySchema.index({ status: 1, nextAttemptAt: 1 });
webhookDeliverySchema.index({ merchant: 1, createdAt: -1 });

module.exports = model('WebhookDelivery', webhookDeliverySchema);
