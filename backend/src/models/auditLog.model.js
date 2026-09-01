'use strict';

const { Schema, model } = require('mongoose');

/**
 * Immutable audit trail of privileged actions.
 *
 * Answers the compliance question "who did what, when, from where" for every
 * state-changing operation. Written on the request path for auth events and
 * asynchronously for everything else, so audit logging can never add latency
 * to a payment.
 */
const auditLogSchema = new Schema(
  {
    action: { type: String, required: true, index: true },
    outcome: { type: String, enum: ['SUCCESS', 'FAILURE'], required: true },

    actor: {
      userId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
      email: { type: String, default: null },
      role: { type: String, default: null },
      ipAddress: { type: String, default: null },
      userAgent: { type: String, default: null },
    },

    merchant: { type: Schema.Types.ObjectId, ref: 'Merchant', default: null, index: true },
    target: {
      type: { type: String, default: null },   // 'Payment', 'Refund', 'WebhookEndpoint'…
      id: { type: String, default: null },
    },

    /** Before/after snapshot for mutations; redacted of secrets by the service. */
    changes: { type: Schema.Types.Mixed, default: null },
    metadata: { type: Schema.Types.Mixed, default: null },
    reason: { type: String, default: null },

    correlationId: { type: String, default: null, index: true },
    requestId: { type: String, default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: false }, // audit records are never updated
    toJSON: { transform: (_d, ret) => { delete ret.__v; return ret; } },
  },
);

auditLogSchema.index({ createdAt: -1 });
auditLogSchema.index({ 'actor.userId': 1, createdAt: -1 });
auditLogSchema.index({ merchant: 1, action: 1, createdAt: -1 });
auditLogSchema.index({ 'target.type': 1, 'target.id': 1 });

/** Same immutability posture as the ledger: append-only by construction. */
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany']) {
  auditLogSchema.pre(op, function blockMutation(next) {
    next(new Error(`Audit logs are append-only; '${op}' is not permitted`));
  });
}

module.exports = model('AuditLog', auditLogSchema);
