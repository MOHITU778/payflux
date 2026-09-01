'use strict';

const { Schema, model } = require('mongoose');

/**
 * Ledger of webhooks *received* from acquirers/PSPs.
 *
 * Upstream providers guarantee at-least-once delivery, so the same
 * authorisation notification will arrive more than once. The unique index on
 * (provider, providerEventId) is the deduplication primitive: the second copy
 * fails to insert and is acknowledged with 200 without being reprocessed.
 */
const inboundWebhookSchema = new Schema(
  {
    provider: { type: String, required: true },
    providerEventId: { type: String, required: true },
    eventType: { type: String, required: true, index: true },

    signatureValid: { type: Boolean, required: true },
    signatureFailureReason: { type: String, default: null },

    payload: { type: Schema.Types.Mixed, required: true },
    headers: { type: Schema.Types.Mixed, default: null },
    sourceIp: { type: String, default: null },

    status: {
      type: String,
      enum: ['RECEIVED', 'PROCESSED', 'IGNORED', 'REJECTED', 'FAILED'],
      default: 'RECEIVED',
      index: true,
    },
    processedAt: { type: Date, default: null },
    processingError: { type: String, default: null },

    relatedPaymentId: { type: String, default: null, index: true },
    correlationId: { type: String, default: null },

    /**
     * TTL: raw inbound payloads are operational data, not financial records —
     * the resulting state change lives on the payment and in the ledger. 90
     * days is enough for dispute investigation without unbounded growth.
     */
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
    },
  },
  { timestamps: true, toJSON: { transform: (_d, ret) => { delete ret.__v; return ret; } } },
);

inboundWebhookSchema.index({ provider: 1, providerEventId: 1 }, { unique: true });
inboundWebhookSchema.index({ createdAt: -1 });
inboundWebhookSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = model('InboundWebhook', inboundWebhookSchema);
