'use strict';

const Joi = require('joi');
const common = require('./common.validator');
const { CURRENCY, SETTLEMENT_STATUS, FRAUD_DECISION } = require('../constants');

/** Schemas small enough not to warrant their own file. */
const settlement = {
  list: Joi.object({
    ...common.pagination,
    status: Joi.string().valid(...Object.values(SETTLEMENT_STATUS)),
    currency: Joi.string().valid(...Object.values(CURRENCY)),
    merchantId: common.merchantId,
  }),
  trigger: Joi.object({
    merchantId: common.merchantId.required(),
    currency: Joi.string().valid(...Object.values(CURRENCY)),
  }),
  idParam: Joi.object({ settlementId: common.settlementId.required() }),
};

const fraud = {
  list: Joi.object({
    ...common.pagination,
    ...common.dateRange,
    decision: Joi.string().valid(...Object.values(FRAUD_DECISION)),
    minScore: Joi.number().min(0).max(100),
    merchantId: common.merchantId,
  }),
  review: Joi.object({
    decision: Joi.string().valid(...Object.values(FRAUD_DECISION)).required(),
    notes: Joi.string().max(1000).allow('', null),
  }),
};

const analytics = {
  query: Joi.object({
    ...common.dateRange,
    currency: Joi.string().valid(...Object.values(CURRENCY)).default('INR'),
    unit: Joi.string().valid('hour', 'day', 'week'),
    merchantId: common.merchantId,
  }),
};

const ledger = {
  statement: Joi.object({
    ...common.pagination,
    currency: Joi.string().valid(...Object.values(CURRENCY)).default('INR'),
  }),
  trialBalance: Joi.object({
    ...common.dateRange,
    currency: Joi.string().valid(...Object.values(CURRENCY)).default('INR'),
  }),
};

const audit = {
  list: Joi.object({
    ...common.pagination,
    ...common.dateRange,
    action: Joi.string().max(60),
    outcome: Joi.string().valid('SUCCESS', 'FAILURE'),
    correlationId: Joi.string().max(80),
    merchantId: common.merchantId,
  }),
};

module.exports = {
  common,
  payment: require('./payment.validator'),
  refund: require('./refund.validator'),
  auth: require('./auth.validator'),
  webhook: require('./webhook.validator'),
  settlement,
  fraud,
  analytics,
  ledger,
  audit,
};
