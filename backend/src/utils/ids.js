'use strict';

const crypto = require('node:crypto');

/**
 * Public identifiers.
 *
 * Resources are addressed by a prefixed, URL-safe, non-sequential id rather
 * than by their Mongo `_id`. Prefixes make ids self-describing in logs and
 * support tickets (`pay_…` is obviously a payment), and non-sequential ids stop
 * a merchant from inferring our transaction volume.
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Rejection-sampled random string — uniform across the alphabet, no modulo bias. */
function randomString(length) {
  const out = [];
  const limit = 256 - (256 % ALPHABET.length);
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length)) {
      if (byte >= limit) continue;          // discard biased tail
      out.push(ALPHABET[byte % ALPHABET.length]);
      if (out.length === length) break;
    }
  }
  return out.join('');
}

const prefixed = (prefix, length = 20) => () => `${prefix}_${randomString(length)}`;

module.exports = {
  randomString,
  paymentId: prefixed('pay'),
  refundId: prefixed('rfnd'),
  transactionId: prefixed('txn'),
  ledgerEntryId: prefixed('lgr'),
  journalId: prefixed('jrn'),
  settlementId: prefixed('setl'),
  merchantId: prefixed('mrch', 16),
  webhookEndpointId: prefixed('whep', 16),
  deliveryId: prefixed('whdl'),
  eventId: prefixed('evt'),
  invoiceId: prefixed('inv'),
  fraudLogId: prefixed('frd'),
  /** API key pair handed to merchants: public id + secret shown once. */
  apiKey: () => `pk_${randomString(24)}`,
  apiSecret: () => `sk_${randomString(40)}`,
};
