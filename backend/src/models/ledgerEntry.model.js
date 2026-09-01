'use strict';

const { Schema, model } = require('mongoose');
const { ENTRY_TYPE, CURRENCY } = require('../constants');

/**
 * A single leg of a journal — the atom of the double-entry ledger.
 *
 * Entries are **immutable**. Corrections are made by posting a reversing
 * journal, never by editing history; the pre-save hook below enforces that at
 * the ODM level so no service can accidentally rewrite a posted amount.
 *
 * `balanceAfterMinor` snapshots the account's running balance at the moment
 * this entry was applied, which is what turns the entry stream into a
 * statement the merchant can read line by line.
 */
const ledgerEntrySchema = new Schema(
  {
    entryId: { type: String, required: true, unique: true },
    journalId: { type: String, required: true, index: true },

    account: { type: Schema.Types.ObjectId, ref: 'LedgerAccount', required: true, index: true },
    accountCode: { type: String, required: true },

    entryType: { type: String, enum: Object.values(ENTRY_TYPE), required: true },
    amountMinor: {
      type: Number,
      required: true,
      min: [1, 'Ledger entries must carry a positive amount'],
      validate: { validator: Number.isInteger, message: 'Ledger amounts must be integers' },
    },
    currency: { type: String, enum: Object.values(CURRENCY), required: true },

    /** Account balance immediately after applying this entry. */
    balanceAfterMinor: { type: Number, required: true },
    /** Per-account monotonic position, for gap detection during reconciliation. */
    sequence: { type: Number, required: true },

    merchant: { type: Schema.Types.ObjectId, ref: 'Merchant', default: null, index: true },
    reference: {
      type: { type: String, enum: ['Payment', 'Refund', 'Settlement'], required: true },
      id: { type: String, required: true },
    },
    description: { type: String, default: null },
    postedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
    toJSON: { transform: (_d, ret) => { delete ret.__v; return ret; } },
  },
);

// Statement view: one account, in posting order.
ledgerEntrySchema.index({ account: 1, sequence: -1 });
ledgerEntrySchema.index({ account: 1, postedAt: -1 });
ledgerEntrySchema.index({ merchant: 1, postedAt: -1 });
ledgerEntrySchema.index({ 'reference.type': 1, 'reference.id': 1 });
// Guarantees no account can receive two entries at the same sequence, which is
// what makes gap/duplicate detection meaningful.
ledgerEntrySchema.index({ account: 1, sequence: 1 }, { unique: true });

/** Immutability guard: a persisted entry may never be modified. */
ledgerEntrySchema.pre('save', function preventMutation(next) {
  if (!this.isNew) {
    return next(new Error('Ledger entries are immutable; post a reversing journal instead'));
  }
  return next();
});

// The same guard for query-level updates, which bypass document middleware.
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne']) {
  ledgerEntrySchema.pre(op, function blockUpdate(next) {
    next(new Error(`Ledger entries are immutable; '${op}' is not permitted`));
  });
}

module.exports = model('LedgerEntry', ledgerEntrySchema);
