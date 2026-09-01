'use strict';

const logger = require('../config/logger');
const money = require('../utils/money');

/**
 * Notification worker.
 *
 * A stand-in for a real provider (SES, SendGrid, Twilio). The boundary is what
 * matters: notifications are on their own queue with a modest retry budget,
 * because unlike a ledger posting a lost receipt email is an inconvenience, not
 * a financial defect. Keeping them off the payment path means an email outage
 * can never fail a payment.
 */

const log = logger.child({ component: 'worker:notification' });

/** Rendered message bodies, kept simple and data-driven. */
const TEMPLATES = {
  payment_succeeded: (data) => ({
    subject: `Payment received — ${money.toMajorString(data.amountMinor, data.currency)} ${data.currency}`,
    body: `Your payment ${data.paymentId} to ${data.merchantName} was successful.`,
  }),
  payment_failed: (data) => ({
    subject: 'Payment failed',
    body: `Payment ${data.paymentId} could not be completed (${data.failureCode}).`,
  }),
  refund_processed: (data) => ({
    subject: `Refund processed — ${money.toMajorString(data.amountMinor, data.currency)} ${data.currency}`,
    body: `Refund ${data.refundId} against payment ${data.paymentId} has been issued.`,
  }),
  settlement_completed: (data) => ({
    subject: 'Settlement completed',
    body: `Settlement ${data.settlementId} of ${money.toMajorString(data.netAmountMinor, data.currency)} has been paid out.`,
  }),
};

async function process(job) {
  const { template, to, ...data } = job.data;
  const render = TEMPLATES[template];

  if (!render) {
    // An unknown template will never become known on a retry — fail terminally
    // rather than burning the retry budget.
    log.error('unknown notification template', { template });
    return { sent: false, reason: 'UNKNOWN_TEMPLATE' };
  }
  if (!to) {
    log.debug('no recipient for notification, skipping', { template });
    return { sent: false, reason: 'NO_RECIPIENT' };
  }

  const message = render(data);
  // A real provider call goes here; the retry/backoff policy around it is
  // already configured on the queue.
  log.info('notification dispatched', { template, to, subject: message.subject });
  return { sent: true, to, subject: message.subject };
}

module.exports = { process, TEMPLATES };
