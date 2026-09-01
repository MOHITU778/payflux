'use strict';

const { Schema, model } = require('mongoose');
const { CURRENCY } = require('../constants');

/**
 * A journal is one balanced financial event — the transactional envelope that
 * groups the debit and credit legs of a single business fact.
 *
 * The invariant `totalDebitMinor === totalCreditMinor` is asserted before the
 * journal is marked POSTED. A journal that fails the check is stored as
 * REJECTED rather than discarded, so an accounting bug leaves evidence.
 */
const journalSchema = new Schema(
  {
    journalId: { type: String, required: true, unique: true },
    /** Business meaning: 'payment.capture', 'refund.settle', 'settlement.payout'. */
    eventType: { type: String, required: true, index: true },

    merchant: { type: Schema.Types.ObjectId, ref: 'Merchant', default: null, index: true },
    currency: { type: String, enum: Object.values(CURRENCY), required: true },

    totalDebitMinor: { type: Number, required: true, min: 0 },
    totalCreditMinor: { type: Number, required: true, min: 0 },
    entryCount: { type: Number, required: true, min: 2 },

    status: {
      type: String,
      enum: ['POSTED', 'REJECTED', 'REVERSED'],
      default: 'POSTED',
      index: true,
    },
    /** Set when a correcting journal reverses this one. */
    reversedByJournalId: { type: String, default: null },
    reversesJournalId: { type: String, default: null },

    reference: {
      type: { type: String, enum: ['Payment', 'Refund', 'Settlement'], required: true },
      id: { type: String, required: true },
    },
    /**
     * Deterministic key derived from (eventType, referenceId). A unique index
     * on it makes ledger posting idempotent: a retried worker cannot double-post
     * the same financial event even if the job is delivered twice.
     */
    idempotencyKey: { type: String, required: true, unique: true },

    description: { type: String, default: null },
    correlationId: { type: String, default: null },
    postedAt: { type: Date, default: Date.now },
  },
  { timestamps: true, toJSON: { transform: (_d, ret) => { delete ret.__v; return ret; } } },
);

journalSchema.index({ merchant: 1, postedAt: -1 });
journalSchema.index({ 'reference.type': 1, 'reference.id': 1 });

module.exports = model('Journal', journalSchema);
