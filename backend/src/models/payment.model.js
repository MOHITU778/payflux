'use strict';

const { Schema, model } = require('mongoose');
const {
  PAYMENT_STATUS, PAYMENT_METHOD, CURRENCY, FRAUD_DECISION, TERMINAL_PAYMENT_STATUSES,
} = require('../constants');

/**
 * An append-only record of every state the payment has occupied.
 * This is the audit trail support reads first when a merchant disputes an
 * outcome, and it is what makes an illegal transition provable after the fact.
 */
const stateTransitionSchema = new Schema(
  {
    from: { type: String, enum: [...Object.values(PAYMENT_STATUS), 'NONE'], required: true },
    to: { type: String, enum: Object.values(PAYMENT_STATUS), required: true },
    reason: { type: String, default: null },
    actor: { type: String, default: 'system' },   // userId, 'system', or 'acquirer'
    correlationId: { type: String, default: null },
    at: { type: Date, default: Date.now },
  },
  { _id: false },
);

const paymentSchema = new Schema(
  {
    paymentId: { type: String, required: true, unique: true },
    merchant: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true, index: true },

    // ── Money ────────────────────────────────────────────────────────────
    // Integer minor units only. See utils/money.js for the reasoning.
    amountMinor: {
      type: Number,
      required: true,
      min: [1, 'Amount must be positive'],
      validate: { validator: Number.isInteger, message: 'Amount must be an integer (minor units)' },
    },
    currency: { type: String, enum: Object.values(CURRENCY), required: true },
    /** Cumulative amount refunded; drives PARTIALLY_REFUNDED vs REFUNDED. */
    amountRefundedMinor: { type: Number, default: 0, min: 0 },
    /** Platform fee, computed at capture time and frozen thereafter. */
    feeMinor: { type: Number, default: 0, min: 0 },

    status: {
      type: String,
      enum: Object.values(PAYMENT_STATUS),
      default: PAYMENT_STATUS.PENDING,
      required: true,
      index: true,
    },
    method: { type: String, enum: Object.values(PAYMENT_METHOD), required: true },

    // ── Customer & instrument ───────────────────────────────────────────
    customer: {
      customerId: { type: String, default: null },
      email: { type: String, default: null, lowercase: true },
      contact: { type: String, default: null },
      // Only the network-safe fragment of the instrument is ever persisted.
      // Full PANs never enter this system — that is the acquirer's scope.
      last4: { type: String, default: null, maxlength: 4 },
      network: { type: String, default: null },
    },

    // ── Request provenance, used by the fraud engine ────────────────────
    context: {
      ipAddress: { type: String, default: null },
      country: { type: String, default: null, uppercase: true },
      userAgent: { type: String, default: null },
      deviceFingerprint: { type: String, default: null },
    },

    risk: {
      score: { type: Number, default: 0, min: 0, max: 100 },
      decision: { type: String, enum: Object.values(FRAUD_DECISION), default: FRAUD_DECISION.ALLOW },
      triggeredRules: { type: [String], default: [] },
    },

    // ── Acquirer linkage ────────────────────────────────────────────────
    acquirer: {
      name: { type: String, default: null },
      referenceId: { type: String, default: null },
      authCode: { type: String, default: null },
      capturedAt: { type: Date, default: null },
    },

    failure: {
      code: { type: String, default: null },
      message: { type: String, default: null },
      at: { type: Date, default: null },
    },

    /** Key that produced this payment — supports idempotent lookup after a Redis flush. */
    idempotencyKey: { type: String, default: null },

    description: { type: String, default: null, maxlength: 500 },
    notes: { type: Map, of: String, default: undefined },

    stateHistory: { type: [stateTransitionSchema], default: [] },

    settlement: { type: Schema.Types.ObjectId, ref: 'Settlement', default: null, index: true },
    settledAt: { type: Date, default: null },

    /** Set when the payment reaches a terminal state; drives analytics windows. */
    completedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    // Mongoose's `__v` is used as an optimistic-concurrency token by the
    // payment repository: a status update asserts the version it read.
    optimisticConcurrency: true,
    toJSON: { virtuals: true, transform: (_d, ret) => { delete ret.__v; return ret; } },
  },
);

// ── Index strategy ──────────────────────────────────────────────────────
// The dashboard's dominant access pattern is "this merchant's payments,
// newest first, optionally filtered by status" — served entirely by this
// compound index (ESR: Equality on merchant, Sort on createdAt).
paymentSchema.index({ merchant: 1, createdAt: -1 });
paymentSchema.index({ merchant: 1, status: 1, createdAt: -1 });
// Settlement sweep: captured, unsettled payments older than the hold window.
paymentSchema.index({ status: 1, settledAt: 1, completedAt: 1 });
// Acquirer reconciliation: sparse because most payments never reach the acquirer.
paymentSchema.index({ 'acquirer.referenceId': 1 }, { sparse: true });
// Fraud velocity lookups by customer and by source IP.
paymentSchema.index({ 'customer.email': 1, createdAt: -1 }, { sparse: true });
paymentSchema.index({ 'context.ipAddress': 1, createdAt: -1 }, { sparse: true });
// Idempotent recovery path — partial index keeps it small since most rows are null.
paymentSchema.index(
  { merchant: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

/** Amount still eligible for refund. */
paymentSchema.virtual('refundableMinor').get(function refundable() {
  return Math.max(0, this.amountMinor - this.amountRefundedMinor);
});

paymentSchema.virtual('isTerminal').get(function isTerminal() {
  return TERMINAL_PAYMENT_STATUSES.includes(this.status);
});

/** Net amount owed to the merchant once the platform fee is deducted. */
paymentSchema.virtual('netMinor').get(function net() {
  return this.amountMinor - this.feeMinor - this.amountRefundedMinor;
});

module.exports = model('Payment', paymentSchema);
