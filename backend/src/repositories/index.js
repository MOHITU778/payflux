'use strict';

/**
 * Repository registry.
 *
 * Each entry is a singleton instance — repositories are stateless wrappers over
 * a model, so there is nothing to gain from per-request construction. The
 * service container injects these, which is where a test swaps in a fake.
 */
module.exports = {
  userRepository: require('./user.repository'),
  merchantRepository: require('./merchant.repository'),
  paymentRepository: require('./payment.repository'),
  refundRepository: require('./refund.repository'),
  transactionRepository: require('./transaction.repository'),
  ledgerRepository: require('./ledger.repository'),
  settlementRepository: require('./settlement.repository'),
  webhookRepository: require('./webhook.repository'),
  fraudRepository: require('./fraud.repository'),
  auditRepository: require('./audit.repository'),
  idempotencyRepository: require('./idempotency.repository'),
};
