'use strict';

const Joi = require('joi');
const { CURRENCY, PAYMENT_METHOD, PAYMENT_STATUS } = require('../constants');
const { MAX_LIMIT } = require('../utils/pagination');

/**
 * Reusable Joi fragments.
 *
 * Defining these once means "what is a valid amount?" has a single answer
 * across create-payment, create-refund and every filter that accepts one.
 */

/**
 * Money is only ever accepted in integer minor units.
 *
 * Accepting `12.34` would invite floating-point rounding into the ledger, and
 * `1.005` cannot even be represented exactly in IEEE-754. Requiring the caller
 * to send `1234` makes the contract unambiguous.
 */
const amountMinor = Joi.number()
  .integer()
  .positive()
  .max(1_000_000_000_000)
  .required()
  .messages({
    'number.base': 'amountMinor must be an integer in the currency minor unit (e.g. 1000 = 10.00)',
    'number.integer': 'amountMinor must be an integer — decimals are not accepted for money',
  });

const currency = Joi.string().valid(...Object.values(CURRENCY)).required();

/**
 * Email.
 *
 * `tlds: { allow: false }` disables Joi's check against its bundled IANA TLD
 * list while keeping full structural validation. The list is a snapshot: it
 * rejects newly delegated gTLDs and the RFC 2606 reserved names (`.example`,
 * `.test`) that are correct to use in documentation and fixtures. Bouncing a
 * legitimate merchant's address because our dependency's list is a year stale
 * is a worse failure than accepting a typo, which the confirmation email
 * catches anyway.
 */
const email = Joi.string().email({ minDomainSegments: 2, tlds: { allow: false } }).max(254);
const paymentId = Joi.string().pattern(/^pay_[A-Za-z0-9]{20}$/).messages({
  'string.pattern.base': 'paymentId must look like pay_xxxxxxxxxxxxxxxxxxxx',
});
const refundId = Joi.string().pattern(/^rfnd_[A-Za-z0-9]{20}$/);
const settlementId = Joi.string().pattern(/^setl_[A-Za-z0-9]{20}$/);
const merchantId = Joi.string().pattern(/^mrch_[A-Za-z0-9]{16}$/);

const isoDate = Joi.date().iso();

/** Standard list controls, shared by every paginated endpoint. */
const pagination = {
  page: Joi.number().integer().min(1).default(1),
  limit: Joi.number().integer().min(1).max(MAX_LIMIT).default(20),
  sort: Joi.string().max(100),
};

const dateRange = {
  from: isoDate,
  to: isoDate.min(Joi.ref('from')).messages({
    'date.min': '`to` must not be earlier than `from`',
  }),
  range: Joi.string().valid('1h', '24h', '7d', '30d', '90d'),
};

const customer = Joi.object({
  customerId: Joi.string().max(120),
  email: email.optional(),
  contact: Joi.string().pattern(/^\+?[0-9\s-]{6,20}$/),
  // Only the last four digits of an instrument may be supplied. A full PAN is
  // out of scope for this system and must never be accepted.
  last4: Joi.string().pattern(/^[0-9]{4}$/),
  network: Joi.string().valid('VISA', 'MASTERCARD', 'AMEX', 'RUPAY', 'DISCOVER'),
  country: Joi.string().uppercase().length(2),
}).default({});

const requestContextSchema = Joi.object({
  country: Joi.string().uppercase().length(2),
  deviceFingerprint: Joi.string().max(200),
}).default({});

module.exports = {
  amountMinor,
  email,
  currency,
  paymentId,
  refundId,
  settlementId,
  merchantId,
  isoDate,
  pagination,
  dateRange,
  customer,
  requestContextSchema,
  PAYMENT_METHOD,
  PAYMENT_STATUS,
};
