'use strict';

const Joi = require('joi');
const common = require('./common.validator');
const { PAYMENT_METHOD, PAYMENT_STATUS, CURRENCY } = require('../constants');

/**
 * Payment request schemas.
 *
 * Note what is *absent*: `status`, `feeMinor`, `risk` and `acquirer` are never
 * accepted from a client. `stripUnknown` in the validate middleware silently
 * drops them, so a caller cannot self-declare a payment successful or set its
 * own fee to zero. Server-authored fields must never appear in an input schema.
 */

const createPayment = Joi.object({
  amountMinor: common.amountMinor,
  currency: common.currency,
  method: Joi.string().valid(...Object.values(PAYMENT_METHOD)).required(),
  customer: common.customer,
  context: common.requestContextSchema,
  description: Joi.string().max(500).allow('', null),
  // Free-form merchant metadata, bounded so it cannot become a data dump.
  notes: Joi.object().pattern(Joi.string().max(40), Joi.string().max(500)).max(20),
});

const paymentIdParam = Joi.object({
  paymentId: common.paymentId.required(),
});

const listPayments = Joi.object({
  ...common.pagination,
  ...common.dateRange,
  status: Joi.alternatives().try(
    Joi.string().valid(...Object.values(PAYMENT_STATUS)),
    // Comma-separated multi-select from the dashboard's filter chips.
    Joi.string().pattern(/^[A-Z_]+(,[A-Z_]+)*$/),
  ),
  method: Joi.string().valid(...Object.values(PAYMENT_METHOD)),
  currency: Joi.string().valid(...Object.values(CURRENCY)),
  paymentId: common.paymentId,
  customerEmail: Joi.string().email(),
  minAmount: Joi.number().integer().min(0),
  maxAmount: Joi.number().integer().min(0),
  merchantId: common.merchantId,
});

const cancelPayment = Joi.object({
  reason: Joi.string().max(300).default('Cancelled by merchant'),
});

const verifyPayment = Joi.object({
  // Set false to read the stored state without contacting the acquirer.
  reconcile: Joi.boolean().default(true),
});

const transactionHistory = Joi.object({
  ...common.pagination,
  ...common.dateRange,
  q: Joi.string().max(100),
  type: Joi.string().valid('PAYMENT', 'REFUND', 'SETTLEMENT', 'FEE', 'CHARGEBACK', 'ADJUSTMENT'),
  status: Joi.string().max(30),
  merchantId: common.merchantId,
});

module.exports = {
  createPayment,
  paymentIdParam,
  listPayments,
  cancelPayment,
  verifyPayment,
  transactionHistory,
};
