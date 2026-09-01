'use strict';

const { Schema, model } = require('mongoose');
const { CURRENCY } = require('../constants');

/**
 * The merchant-facing transaction feed.
 *
 * This is a denormalised projection over payments, refunds and settlements —
 * a single chronological stream the dashboard can page through without
 * `$unionWith` across three collections at query time. It is written by the
 * async pipeline, so it is eventually consistent with the payment record and
 * must never be treated as the source of truth for money (the ledger is).
 */
const transactionSchema = new Schema(
  {
    transactionId: { type: String, required: true, unique: true },
    merchant: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true, index: true },

    type: {
      type: String,
      enum: ['PAYMENT', 'REFUND', 'SETTLEMENT', 'FEE', 'CHARGEBACK', 'ADJUSTMENT'],
      required: true,
      index: true,
    },
    /** Signed from the merchant's perspective: credit positive, debit negative. */
    direction: { type: String, enum: ['CREDIT', 'DEBIT'], required: true },

    amountMinor: { type: Number, required: true },
    feeMinor: { type: Number, default: 0 },
    netMinor: { type: Number, required: true },
    currency: { type: String, enum: Object.values(CURRENCY), required: true },

    status: { type: String, required: true, index: true },
    description: { type: String, default: null },

    /** Polymorphic pointer to the originating document. */
    sourceType: { type: String, enum: ['Payment', 'Refund', 'Settlement'], required: true },
    sourceId: { type: String, required: true, index: true },

    journalId: { type: String, default: null, index: true },
    occurredAt: { type: Date, required: true, default: Date.now },
  },
  { timestamps: true, toJSON: { transform: (_d, ret) => { delete ret.__v; return ret; } } },
);

// Primary feed query: one merchant, reverse-chronological, optional type filter.
transactionSchema.index({ merchant: 1, occurredAt: -1 });
transactionSchema.index({ merchant: 1, type: 1, occurredAt: -1 });
transactionSchema.index({ merchant: 1, status: 1, occurredAt: -1 });

module.exports = model('Transaction', transactionSchema);
