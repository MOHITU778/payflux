'use strict';

const logger = require('../config/logger');
const { EVENT } = require('../constants');
const producers = require('../queues/producers');
const { paymentRepository, refundRepository, merchantRepository, transactionRepository } =
  require('../repositories');
const ids = require('../utils/ids');
const webhookService = require('../services/webhook.service');

/**
 * Payment event fan-out.
 *
 * The hub of the async pipeline. It consumes one domain event and dispatches
 * the independent consequences — transaction feed row, webhook fan-out,
 * notification, invoice — instead of the payment service knowing about all of
 * them. Adding a new reaction to "payment succeeded" means adding a case here,
 * not editing the payment path.
 *
 * Every branch is idempotent, because BullMQ delivers at least once.
 */

const log = logger.child({ component: 'worker:payment-events' });

/** Mirror a payment into the merchant-facing transaction feed. */
async function projectPaymentTransaction(payment, merchant) {
  const existing = await transactionRepository.findOne({
    sourceType: 'Payment', sourceId: payment.paymentId, type: 'PAYMENT',
  });
  if (existing) return existing; // redelivery — the projection already exists

  return transactionRepository.create({
    transactionId: ids.transactionId(),
    merchant: merchant._id,
    type: 'PAYMENT',
    direction: 'CREDIT',
    amountMinor: payment.amountMinor,
    feeMinor: payment.feeMinor ?? 0,
    netMinor: payment.amountMinor - (payment.feeMinor ?? 0),
    currency: payment.currency,
    status: payment.status,
    description: payment.description ?? `Payment ${payment.paymentId}`,
    sourceType: 'Payment',
    sourceId: payment.paymentId,
    occurredAt: payment.completedAt ?? payment.createdAt,
  });
}

async function projectRefundTransaction(refund, merchant) {
  const existing = await transactionRepository.findOne({
    sourceType: 'Refund', sourceId: refund.refundId,
  });
  if (existing) return existing;

  return transactionRepository.create({
    transactionId: ids.transactionId(),
    merchant: merchant._id,
    type: 'REFUND',
    direction: 'DEBIT',
    amountMinor: -refund.amountMinor,   // signed from the merchant's perspective
    netMinor: -refund.amountMinor,
    currency: refund.currency,
    status: refund.status,
    description: `Refund ${refund.refundId} against ${refund.paymentId}`,
    sourceType: 'Refund',
    sourceId: refund.refundId,
    occurredAt: refund.processedAt ?? refund.createdAt,
  });
}

/**
 * @param {import('bullmq').Job} job
 */
async function process(job) {
  const { eventType, paymentId, refundId, settlementId, eventId } = job.data;
  log.info('handling event', { eventType, paymentId, refundId, jobId: job.id });

  switch (eventType) {
    case EVENT.PAYMENT_SUCCEEDED: {
      const payment = await paymentRepository.findByPaymentId(paymentId);
      if (!payment) {
        // Nothing to do and nothing will change — do not retry.
        log.warn('event references a payment that no longer exists', { paymentId });
        return { skipped: true };
      }
      const merchant = await merchantRepository.findById(payment.merchant);

      await projectPaymentTransaction(payment, merchant);

      // Fan out in parallel: none of these depend on each other.
      await Promise.all([
        webhookService.fanout({
          merchantObjectId: merchant._id,
          eventType,
          eventId,
          data: {
            paymentId: payment.paymentId,
            status: payment.status,
            amountMinor: payment.amountMinor,
            currency: payment.currency,
            method: payment.method,
            createdAt: payment.createdAt,
          },
        }),
        producers.generateInvoice(paymentId),
        producers.sendNotification('payment_succeeded', {
          to: payment.customer?.email,
          merchantName: merchant.name,
          paymentId,
          amountMinor: payment.amountMinor,
          currency: payment.currency,
        }),
      ]);
      return { fannedOut: true };
    }

    case EVENT.PAYMENT_FAILED:
    case EVENT.PAYMENT_CANCELLED:
    case EVENT.FRAUD_BLOCKED: {
      const payment = await paymentRepository.findByPaymentId(paymentId);
      if (!payment) return { skipped: true };
      const merchant = await merchantRepository.findById(payment.merchant);

      await projectPaymentTransaction(payment, merchant);
      await webhookService.fanout({
        merchantObjectId: merchant._id,
        eventType,
        eventId,
        data: {
          paymentId,
          status: payment.status,
          failureCode: payment.failure?.code ?? null,
          riskScore: payment.risk?.score,
        },
      });
      return { fannedOut: true };
    }

    case EVENT.REFUND_SUCCEEDED:
    case EVENT.REFUND_FAILED:
    case EVENT.REFUND_INITIATED: {
      const refund = await refundRepository.findByRefundId(refundId);
      if (!refund) return { skipped: true };
      const merchant = await merchantRepository.findById(refund.merchant);

      if (eventType === EVENT.REFUND_SUCCEEDED) {
        await projectRefundTransaction(refund, merchant);
        await producers.sendNotification('refund_processed', {
          to: null,
          refundId,
          paymentId: refund.paymentId,
          amountMinor: refund.amountMinor,
          currency: refund.currency,
        });
      }

      await webhookService.fanout({
        merchantObjectId: merchant._id,
        eventType,
        eventId,
        data: {
          refundId,
          paymentId: refund.paymentId,
          status: refund.status,
          amountMinor: refund.amountMinor,
          currency: refund.currency,
        },
      });
      return { fannedOut: true };
    }

    case EVENT.SETTLEMENT_CREATED:
    case EVENT.SETTLEMENT_COMPLETED: {
      const { settlementRepository } = require('../repositories');
      const settlement = await settlementRepository.findBySettlementId(settlementId);
      if (!settlement) return { skipped: true };

      await webhookService.fanout({
        merchantObjectId: settlement.merchant,
        eventType,
        eventId,
        data: {
          settlementId,
          status: settlement.status,
          netAmountMinor: settlement.netAmountMinor,
          currency: settlement.currency,
          paymentCount: settlement.paymentCount,
        },
      });
      return { fannedOut: true };
    }

    default:
      log.warn('no handler for event type', { eventType });
      return { skipped: true };
  }
}

module.exports = { process, projectPaymentTransaction, projectRefundTransaction };
