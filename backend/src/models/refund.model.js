'use strict';

const { Schema, model } = require('mongoose');
const { REFUND_STATUS, CURRENCY } = require('../constants');

/**
 * Refunds are first-class documents rather than fields on the payment: a
 * payment may be refunded many times in part, each attempt has its own
 * lifecycle and its own ledger posting, and each needs its own idempotency key.
 */
const refundSchema = new Schema(
  {
    refundId: { type: String, required: true, unique: true },
    payment: { type: Schema.Types.ObjectId, ref: 'Payment', required: true, index: true },
    paymentId: { type: String, required: true, index: true },
    merchant: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true, index: true },

    amountMinor: {
      type: Number,
      required: true,
      min: [1, 'Refund amount must be positive'],
      validate: { validator: Number.isInteger, message: 'Refund amount must be integer minor units' },
    },
    currency: { type: String, enum: Object.values(CURRENCY), required: true },

    status: {
      type: String,
      enum: Object.values(REFUND_STATUS),
      default: REFUND_STATUS.PENDING,
      index: true,
    },
    /** `true` when the refund covers the payment's full remaining balance. */
    isFullRefund: { type: Boolean, default: false },

    reason: {
      type: String,
      enum: ['REQUESTED_BY_CUSTOMER', 'DUPLICATE', 'FRAUDULENT', 'CHARGEBACK', 'MERCHANT_ERROR', 'OTHER'],
      default: 'REQUESTED_BY_CUSTOMER',
    },
    notes: { type: String, default: null, maxlength: 500 },

    idempotencyKey: { type: String, default: null },
    initiatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    acquirerReferenceId: { type: String, default: null },
    failure: {
      code: { type: String, default: null },
      message: { type: String, default: null },
    },
    processedAt: { type: Date, default: null },
  },
  { timestamps: true, toJSON: { transform: (_d, ret) => { delete ret.__v; return ret; } } },
);

refundSchema.index({ merchant: 1, createdAt: -1 });
refundSchema.index({ payment: 1, status: 1 });
refundSchema.index(
  { merchant: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
);

module.exports = model('Refund', refundSchema);
