'use strict';

/**
 * Single source of truth for every domain enum in the system.
 * Mongoose schemas, validators, the state machine and the Angular client all
 * derive from these values, so a status can never drift between layers.
 */

/** Lifecycle states of a payment intent. */
const PAYMENT_STATUS = Object.freeze({
  PENDING: 'PENDING',
  AUTHORIZED: 'AUTHORIZED',
  PROCESSING: 'PROCESSING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  REFUNDED: 'REFUNDED',
  PARTIALLY_REFUNDED: 'PARTIALLY_REFUNDED',
  CANCELLED: 'CANCELLED',
});

/**
 * Directed adjacency list for the payment state machine.
 * A transition not listed here is rejected by `StateMachineService`, which is
 * what stops a settled payment from being cancelled or a refund from being
 * applied twice.
 */
const PAYMENT_TRANSITIONS = Object.freeze({
  [PAYMENT_STATUS.PENDING]: [
    PAYMENT_STATUS.AUTHORIZED,
    PAYMENT_STATUS.PROCESSING,
    PAYMENT_STATUS.FAILED,
    PAYMENT_STATUS.CANCELLED,
  ],
  [PAYMENT_STATUS.AUTHORIZED]: [
    PAYMENT_STATUS.PROCESSING,
    PAYMENT_STATUS.SUCCESS,
    PAYMENT_STATUS.FAILED,
    PAYMENT_STATUS.CANCELLED,
  ],
  [PAYMENT_STATUS.PROCESSING]: [
    PAYMENT_STATUS.SUCCESS,
    PAYMENT_STATUS.FAILED,
  ],
  [PAYMENT_STATUS.SUCCESS]: [
    PAYMENT_STATUS.REFUNDED,
    PAYMENT_STATUS.PARTIALLY_REFUNDED,
  ],
  [PAYMENT_STATUS.PARTIALLY_REFUNDED]: [
    PAYMENT_STATUS.REFUNDED,
    PAYMENT_STATUS.PARTIALLY_REFUNDED,
  ],
  // Terminal states — no outgoing edges.
  [PAYMENT_STATUS.FAILED]: [],
  [PAYMENT_STATUS.REFUNDED]: [],
  [PAYMENT_STATUS.CANCELLED]: [],
});

const TERMINAL_PAYMENT_STATUSES = Object.freeze([
  PAYMENT_STATUS.FAILED,
  PAYMENT_STATUS.REFUNDED,
  PAYMENT_STATUS.CANCELLED,
]);

const REFUND_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
});

const SETTLEMENT_STATUS = Object.freeze({
  QUEUED: 'QUEUED',
  PROCESSING: 'PROCESSING',
  SETTLED: 'SETTLED',
  FAILED: 'FAILED',
});

/** Double-entry primitives. */
const ENTRY_TYPE = Object.freeze({ DEBIT: 'DEBIT', CREDIT: 'CREDIT' });

/**
 * Chart of accounts. Normal balance decides whether a debit increases (assets,
 * expenses) or decreases (liabilities, revenue) the running balance.
 */
const ACCOUNT_TYPE = Object.freeze({
  ASSET: 'ASSET',
  LIABILITY: 'LIABILITY',
  REVENUE: 'REVENUE',
  EXPENSE: 'EXPENSE',
});

const NORMAL_BALANCE = Object.freeze({
  [ACCOUNT_TYPE.ASSET]: ENTRY_TYPE.DEBIT,
  [ACCOUNT_TYPE.EXPENSE]: ENTRY_TYPE.DEBIT,
  [ACCOUNT_TYPE.LIABILITY]: ENTRY_TYPE.CREDIT,
  [ACCOUNT_TYPE.REVENUE]: ENTRY_TYPE.CREDIT,
});

/** Well-known ledger accounts created on bootstrap. */
const SYSTEM_ACCOUNT = Object.freeze({
  GATEWAY_CLEARING: 'gateway_clearing',   // ASSET  — funds held at the acquirer
  PLATFORM_REVENUE: 'platform_revenue',   // REVENUE— our processing fee
  PAYMENT_REVERSALS: 'payment_reversals', // EXPENSE— refunded value
});

const ROLE = Object.freeze({
  ADMIN: 'ADMIN',
  MERCHANT: 'MERCHANT',
  SUPPORT: 'SUPPORT',
});

const FRAUD_DECISION = Object.freeze({
  ALLOW: 'ALLOW',
  REVIEW: 'REVIEW',
  BLOCK: 'BLOCK',
});

const WEBHOOK_DELIVERY_STATUS = Object.freeze({
  PENDING: 'PENDING',
  DELIVERED: 'DELIVERED',
  RETRYING: 'RETRYING',
  FAILED: 'FAILED',
  DEAD_LETTERED: 'DEAD_LETTERED',
});

/** Queue names — also used as BullMQ key prefixes and metric labels. */
const QUEUE = Object.freeze({
  PAYMENT_EVENTS: 'payment-events',
  LEDGER: 'ledger',
  SETTLEMENT: 'settlement',
  WEBHOOK_DISPATCH: 'webhook-dispatch',
  NOTIFICATION: 'notification',
  INVOICE: 'invoice',
  DEAD_LETTER: 'dead-letter',
});

/** Event names emitted onto the async pipeline. */
const EVENT = Object.freeze({
  PAYMENT_CREATED: 'payment.created',
  PAYMENT_AUTHORIZED: 'payment.authorized',
  PAYMENT_SUCCEEDED: 'payment.succeeded',
  PAYMENT_FAILED: 'payment.failed',
  PAYMENT_CANCELLED: 'payment.cancelled',
  REFUND_INITIATED: 'refund.initiated',
  REFUND_SUCCEEDED: 'refund.succeeded',
  REFUND_FAILED: 'refund.failed',
  SETTLEMENT_CREATED: 'settlement.created',
  SETTLEMENT_COMPLETED: 'settlement.completed',
  FRAUD_BLOCKED: 'fraud.blocked',
  INVOICE_GENERATED: 'invoice.generated',
});

const PAYMENT_METHOD = Object.freeze({
  CARD: 'CARD',
  UPI: 'UPI',
  NETBANKING: 'NETBANKING',
  WALLET: 'WALLET',
});

const CURRENCY = Object.freeze({
  INR: 'INR',
  USD: 'USD',
  EUR: 'EUR',
  GBP: 'GBP',
});

/** Minor-unit exponent per currency (all four are 2-decimal currencies). */
const CURRENCY_EXPONENT = Object.freeze({ INR: 2, USD: 2, EUR: 2, GBP: 2 });

const AUDIT_ACTION = Object.freeze({
  LOGIN: 'auth.login',
  LOGIN_FAILED: 'auth.login_failed',
  PAYMENT_CREATE: 'payment.create',
  PAYMENT_VERIFY: 'payment.verify',
  PAYMENT_CANCEL: 'payment.cancel',
  REFUND_CREATE: 'refund.create',
  SETTLEMENT_RUN: 'settlement.run',
  WEBHOOK_ENDPOINT_CREATE: 'webhook.endpoint.create',
  WEBHOOK_REPLAY: 'webhook.replay',
});

const IDEMPOTENCY_STATE = Object.freeze({
  IN_FLIGHT: 'IN_FLIGHT',
  COMPLETED: 'COMPLETED',
});

module.exports = {
  PAYMENT_STATUS,
  PAYMENT_TRANSITIONS,
  TERMINAL_PAYMENT_STATUSES,
  REFUND_STATUS,
  SETTLEMENT_STATUS,
  ENTRY_TYPE,
  ACCOUNT_TYPE,
  NORMAL_BALANCE,
  SYSTEM_ACCOUNT,
  ROLE,
  FRAUD_DECISION,
  WEBHOOK_DELIVERY_STATUS,
  QUEUE,
  EVENT,
  PAYMENT_METHOD,
  CURRENCY,
  CURRENCY_EXPONENT,
  AUDIT_ACTION,
  IDEMPOTENCY_STATE,
};
