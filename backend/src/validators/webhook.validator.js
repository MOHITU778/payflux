'use strict';

const Joi = require('joi');
const common = require('./common.validator');
const { EVENT, WEBHOOK_DELIVERY_STATUS } = require('../constants');

const createEndpoint = Joi.object({
  url: Joi.string().uri({ scheme: ['http', 'https'] }).max(500).required(),
  description: Joi.string().max(200).allow('', null),
  // Empty means "every event".
  subscribedEvents: Joi.array().items(Joi.string().valid(...Object.values(EVENT))).default([]),
});

const updateEndpoint = Joi.object({
  url: Joi.string().uri({ scheme: ['http', 'https'] }).max(500),
  description: Joi.string().max(200).allow('', null),
  subscribedEvents: Joi.array().items(Joi.string().valid(...Object.values(EVENT))),
  isActive: Joi.boolean(),
}).min(1); // reject an empty PATCH rather than performing a no-op write

const listDeliveries = Joi.object({
  ...common.pagination,
  status: Joi.string().valid(...Object.values(WEBHOOK_DELIVERY_STATUS)),
  eventType: Joi.string().valid(...Object.values(EVENT)),
  merchantId: common.merchantId,
});

const endpointIdParam = Joi.object({
  endpointId: Joi.string().pattern(/^whep_[A-Za-z0-9]{16}$/).required(),
});

const deliveryIdParam = Joi.object({
  deliveryId: Joi.string().pattern(/^whdl_[A-Za-z0-9]{20}$/).required(),
});

module.exports = {
  createEndpoint, updateEndpoint, listDeliveries, endpointIdParam, deliveryIdParam,
};
