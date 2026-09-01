'use strict';

const { Schema, model } = require('mongoose');
const { ACCOUNT_TYPE, CURRENCY } = require('../constants');

/**
 * Chart of accounts.
 *
 * Balances live on the account document and are mutated only through atomic
 * `$inc` operations issued alongside the ledger entries that justify them.
 * They are a *cache* of the entry stream: `ReconciliationService` recomputes
 * each balance from the entries and reports any divergence rather than
 * silently trusting this field.
 */
const ledgerAccountSchema = new Schema(
  {
    code: { type: String, required: true },             // e.g. 'merchant_payable:mrch_x9'
    name: { type: String, required: true },
    type: { type: String, enum: Object.values(ACCOUNT_TYPE), required: true, index: true },
    currency: { type: String, enum: Object.values(CURRENCY), required: true },

    /** Null for platform-level system accounts. */
    merchant: { type: Schema.Types.ObjectId, ref: 'Merchant', default: null, index: true },

    // Running totals, in minor units. Kept separately so a reconciliation
    // report can show gross activity, not just the net position.
    balanceMinor: { type: Number, default: 0 },
    totalDebitMinor: { type: Number, default: 0 },
    totalCreditMinor: { type: Number, default: 0 },

    /** Monotonic counter; every entry on this account gets the next sequence. */
    entrySequence: { type: Number, default: 0 },

    isSystem: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    lastEntryAt: { type: Date, default: null },
  },
  { timestamps: true, toJSON: { transform: (_d, ret) => { delete ret.__v; return ret; } } },
);

// One account per (code, currency): a merchant holding INR and USD has two.
ledgerAccountSchema.index({ code: 1, currency: 1 }, { unique: true });
ledgerAccountSchema.index({ merchant: 1, type: 1, currency: 1 });

module.exports = model('LedgerAccount', ledgerAccountSchema);
