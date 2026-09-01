'use strict';

const { Schema, model } = require('mongoose');
const { CURRENCY } = require('../constants');

/**
 * Output of a reconciliation run.
 *
 * Each run recomputes account balances from the immutable entry stream and
 * compares them against the cached `balanceMinor`, and checks that every
 * journal is internally balanced. Runs are persisted so that a finance team
 * has a dated, reviewable record — "we checked, here is what we found" — which
 * is what an auditor asks for.
 */
const discrepancySchema = new Schema(
  {
    kind: {
      type: String,
      enum: ['BALANCE_DRIFT', 'UNBALANCED_JOURNAL', 'SEQUENCE_GAP', 'ORPHAN_ENTRY'],
      required: true,
    },
    accountCode: { type: String, default: null },
    journalId: { type: String, default: null },
    expectedMinor: { type: Number, default: null },
    actualMinor: { type: Number, default: null },
    deltaMinor: { type: Number, default: null },
    detail: { type: String, default: null },
  },
  { _id: false },
);

const reconciliationSchema = new Schema(
  {
    runId: { type: String, required: true, unique: true },
    scope: { type: String, enum: ['GLOBAL', 'MERCHANT'], default: 'GLOBAL' },
    merchant: { type: Schema.Types.ObjectId, ref: 'Merchant', default: null, index: true },
    currency: { type: String, enum: Object.values(CURRENCY), required: true },

    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },

    accountsChecked: { type: Number, default: 0 },
    journalsChecked: { type: Number, default: 0 },
    entriesChecked: { type: Number, default: 0 },

    totalDebitMinor: { type: Number, default: 0 },
    totalCreditMinor: { type: Number, default: 0 },
    /** Zero on a healthy ledger — the headline number of the report. */
    imbalanceMinor: { type: Number, default: 0 },

    status: { type: String, enum: ['BALANCED', 'DISCREPANCY_FOUND', 'FAILED'], required: true, index: true },
    discrepancies: { type: [discrepancySchema], default: [] },

    durationMs: { type: Number, default: 0 },
    triggeredBy: { type: String, default: 'scheduler' },
  },
  { timestamps: true, toJSON: { transform: (_d, ret) => { delete ret.__v; return ret; } } },
);

reconciliationSchema.index({ createdAt: -1 });
reconciliationSchema.index({ status: 1, createdAt: -1 });

module.exports = model('Reconciliation', reconciliationSchema);
