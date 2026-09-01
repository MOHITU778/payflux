'use strict';

const { Schema, model } = require('mongoose');
const { SETTLEMENT_STATUS, CURRENCY } = require('../constants');

/**
 * A payout batch: the aggregate of captured payments, less refunds and fees,
 * that becomes owed to a merchant once the hold window has elapsed.
 *
 * Settlements are batched rather than per-payment because bank rails charge per
 * transfer, and because a single reversible batch is far easier to reconcile
 * against a bank statement than ten thousand individual credits.
 */
const settlementSchema = new Schema(
  {
    settlementId: { type: String, required: true, unique: true },
    merchant: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true, index: true },
    currency: { type: String, enum: Object.values(CURRENCY), required: true },

    /** Half-open window [start, end) of payment completion times in this batch. */
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },

    grossAmountMinor: { type: Number, required: true, min: 0 },
    refundedAmountMinor: { type: Number, default: 0, min: 0 },
    feeAmountMinor: { type: Number, default: 0, min: 0 },
    /** gross − refunds − fees. May legitimately be 0; never negative. */
    netAmountMinor: { type: Number, required: true, min: 0 },

    paymentCount: { type: Number, default: 0 },
    refundCount: { type: Number, default: 0 },

    status: {
      type: String,
      enum: Object.values(SETTLEMENT_STATUS),
      default: SETTLEMENT_STATUS.QUEUED,
      index: true,
    },

    payout: {
      reference: { type: String, default: null },
      bankAccountLast4: { type: String, default: null },
      initiatedAt: { type: Date, default: null },
      completedAt: { type: Date, default: null },
    },
    failure: {
      code: { type: String, default: null },
      message: { type: String, default: null },
      attempts: { type: Number, default: 0 },
    },

    journalId: { type: String, default: null },
    /** Deterministic per (merchant, window) — blocks double settlement of a period. */
    batchKey: { type: String, required: true, unique: true },
  },
  { timestamps: true, toJSON: { transform: (_d, ret) => { delete ret.__v; return ret; } } },
);

settlementSchema.index({ merchant: 1, createdAt: -1 });
settlementSchema.index({ status: 1, createdAt: 1 });

module.exports = model('Settlement', settlementSchema);
