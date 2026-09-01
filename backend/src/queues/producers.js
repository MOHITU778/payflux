'use strict';

const { publish, QUEUE } = require('./index');
const { EVENT } = require('../constants');
const requestContext = require('../utils/requestContext');
const ids = require('../utils/ids');

/**
 * Typed producers.
 *
 * Services never call `publish` directly. Routing every emission through a
 * named function means the queue name, job name and deduplication id for a
 * given event are decided in exactly one place — so "which queue does a refund
 * go to?" has a single answer, and a typo cannot silently create a queue that
 * nothing consumes.
 *
 * Every job carries the ambient correlation id, which is what lets a log search
 * follow one payment from the HTTP request through five workers.
 */

/**
 * Build a BullMQ custom job id.
 *
 * BullMQ reserves `:` as its own key separator and rejects any custom id
 * containing one ("Custom Id cannot contain :"). Since `add()` rejects rather
 * than throwing synchronously, a colon here fails *silently* at the producer
 * and the job is simply never enqueued — so every id is joined with `-` and
 * defensively stripped.
 */
const jobId = (...parts) =>
  parts.filter((part) => part !== null && part !== undefined && part !== '')
    .join('-')
    .replace(/:/g, '-');

/** Attach trace context and a stable event id to every payload. */
function envelope(payload) {
  return {
    ...payload,
    eventId: payload.eventId ?? ids.eventId(),
    correlationId: requestContext.get('correlationId') ?? null,
    emittedAt: new Date().toISOString(),
  };
}

module.exports = {
  /**
   * Fan-out hub for a domain event.
   * `jobId` is deterministic on (event, entity) so a producer retry cannot
   * double-dispatch the same business fact.
   */
  emitPaymentEvent(eventType, payload) {
    return publish(QUEUE.PAYMENT_EVENTS, eventType, envelope({ eventType, ...payload }), {
      jobId: jobId(eventType, payload.paymentId ?? payload.refundId ?? payload.settlementId),
    });
  },

  /** Ledger posting for a captured payment. */
  postPaymentToLedger(paymentId) {
    return publish(QUEUE.LEDGER, 'ledger.payment.capture', envelope({ paymentId }), {
      jobId: jobId('ledger', 'capture', paymentId),
      priority: 1, // money first
    });
  },

  postRefundToLedger(refundId) {
    return publish(QUEUE.LEDGER, 'ledger.refund.settle', envelope({ refundId }), {
      jobId: jobId('ledger', 'refund', refundId),
      priority: 1,
    });
  },

  postSettlementToLedger(settlementId) {
    return publish(QUEUE.LEDGER, 'ledger.settlement.payout', envelope({ settlementId }), {
      jobId: jobId('ledger', 'settlement', settlementId),
      priority: 1,
    });
  },

  /** Build a settlement batch for one merchant/currency. */
  buildSettlement(merchantId, currency) {
    return publish(QUEUE.SETTLEMENT, 'settlement.build', envelope({ merchantId, currency }), {
      // One batch build per merchant/currency/hour, even if the scheduler and
      // an operator both trigger it.
      jobId: jobId('settlement', 'build', merchantId, currency, new Date().toISOString().slice(0, 13)),
    });
  },

  executeSettlement(settlementId) {
    return publish(QUEUE.SETTLEMENT, 'settlement.execute', envelope({ settlementId }), {
      jobId: jobId('settlement', 'execute', settlementId),
    });
  },

  /**
   * Deliver one webhook. `delay` schedules a retry per our published ladder.
   * The delivery row already exists — this job only performs the HTTP attempt.
   */
  dispatchWebhook(deliveryId, { delay = 0, attempt = 1 } = {}) {
    return publish(QUEUE.WEBHOOK_DISPATCH, 'webhook.deliver', envelope({ deliveryId, attempt }), {
      delay,
      jobId: jobId('webhook', deliveryId, attempt),
    });
  },

  /** Create delivery rows for every endpoint subscribed to an event. */
  fanoutWebhook(eventType, payload) {
    return publish(QUEUE.WEBHOOK_DISPATCH, 'webhook.fanout', envelope({ eventType, ...payload }), {
      jobId: jobId('webhook', 'fanout', payload.eventId ?? `${eventType}-${payload.paymentId ?? payload.refundId}`),
    });
  },

  sendNotification(template, payload) {
    return publish(QUEUE.NOTIFICATION, 'notification.send', envelope({ template, ...payload }));
  },

  generateInvoice(paymentId) {
    return publish(QUEUE.INVOICE, 'invoice.generate', envelope({ paymentId }), {
      jobId: jobId('invoice', paymentId),
    });
  },

  EVENT,
};
