'use strict';

/** Model registry — one import site for every collection. */
module.exports = {
  User: require('./user.model'),
  Merchant: require('./merchant.model'),
  Payment: require('./payment.model'),
  Refund: require('./refund.model'),
  Transaction: require('./transaction.model'),
  LedgerAccount: require('./ledgerAccount.model'),
  Journal: require('./journal.model'),
  LedgerEntry: require('./ledgerEntry.model'),
  Reconciliation: require('./reconciliation.model'),
  WebhookEndpoint: require('./webhookEndpoint.model'),
  WebhookDelivery: require('./webhookDelivery.model'),
  InboundWebhook: require('./inboundWebhook.model'),
  Settlement: require('./settlement.model'),
  FraudLog: require('./fraudLog.model'),
  AuditLog: require('./auditLog.model'),
  IdempotencyRecord: require('./idempotencyRecord.model'),
};
