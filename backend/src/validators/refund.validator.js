'use strict';

const Joi = require('joi');
const common = require('./common.validator');
const { REFUND_STATUS } = require('../constants');

const createRefund = Joi.object({
  // Optional: omitting it refunds the full remaining balance. Made explicit
  // rather than defaulted to 0, which would be an ambiguous "refund nothing".
  amountMinor: Joi.number().integer().positive().max(1_000_000_000_000).messages({
    'number.integer': 'amountMinor must be an integer in the currency minor unit',
  }),
  reason: Joi.string().valid(
    'REQUESTED_BY_CUSTOMER', 'DUPLICATE', 'FRAUDULENT', 'CHARGEBACK', 'MERCHANT_ERROR', 'OTHER',
  ).default('REQUESTED_BY_CUSTOMER'),
  notes: Joi.string().max(500).allow('', null),
});

const listRefunds = Joi.object({
  ...common.pagination,
  ...common.dateRange,
  status: Joi.string().valid(...Object.values(REFUND_STATUS)),
  paymentId: common.paymentId,
  merchantId: common.merchantId,
});

const refundIdParam = Joi.object({ refundId: common.refundId.required() });

module.exports = { createRefund, listRefunds, refundIdParam };
