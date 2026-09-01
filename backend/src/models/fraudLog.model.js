'use strict';

const { Schema, model } = require('mongoose');
const { FRAUD_DECISION } = require('../constants');

/** The contribution of one rule to the final risk score. */
const ruleHitSchema = new Schema(
  {
    ruleId: { type: String, required: true },
    ruleName: { type: String, required: true },
    weight: { type: Number, required: true },
    severity: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], required: true },
    detail: { type: String, default: null },
    /** Evidence the rule acted on, e.g. { attempts: 14, windowSeconds: 300 }. */
    evidence: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

/**
 * Every risk evaluation is recorded, not just the blocks.
 *
 * Storing ALLOW decisions is what makes the engine tunable: without the score
 * distribution of legitimate traffic there is no way to know whether moving the
 * block threshold from 80 to 70 would catch more fraud or just reject good
 * customers.
 */
const fraudLogSchema = new Schema(
  {
    fraudLogId: { type: String, required: true, unique: true },
    merchant: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true, index: true },
    paymentId: { type: String, default: null, index: true },

    riskScore: { type: Number, required: true, min: 0, max: 100 },
    decision: { type: String, enum: Object.values(FRAUD_DECISION), required: true, index: true },
    triggeredRules: { type: [ruleHitSchema], default: [] },

    /** Snapshot of the signals evaluated, for offline replay against new rules. */
    signals: {
      amountMinor: { type: Number, default: null },
      currency: { type: String, default: null },
      ipAddress: { type: String, default: null },
      ipCountry: { type: String, default: null },
      billingCountry: { type: String, default: null },
      customerEmail: { type: String, default: null },
      deviceFingerprint: { type: String, default: null },
      velocityCount: { type: Number, default: null },
      recentFailureCount: { type: Number, default: null },
    },

    evaluationMs: { type: Number, default: 0 },
    /** Set when an analyst overturns the automated verdict. */
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    reviewDecision: { type: String, enum: [...Object.values(FRAUD_DECISION), null], default: null },
    reviewNotes: { type: String, default: null },
  },
  { timestamps: true, toJSON: { transform: (_d, ret) => { delete ret.__v; return ret; } } },
);

fraudLogSchema.index({ merchant: 1, createdAt: -1 });
fraudLogSchema.index({ decision: 1, createdAt: -1 });
fraudLogSchema.index({ riskScore: -1, createdAt: -1 });

module.exports = model('FraudLog', fraudLogSchema);
