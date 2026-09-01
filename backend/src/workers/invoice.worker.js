'use strict';

const logger = require('../config/logger');
const money = require('../utils/money');
const ids = require('../utils/ids');
const { paymentRepository, merchantRepository } = require('../repositories');

/**
 * Invoice generation worker.
 *
 * Produces the structured invoice document for a captured payment. In
 * production the rendered PDF would be written to object storage and the URL
 * persisted; the queue boundary and the idempotent job id are the parts that
 * matter architecturally.
 */

const log = logger.child({ component: 'worker:invoice' });

async function process(job) {
  const { paymentId } = job.data;
  const payment = await paymentRepository.findByPaymentId(paymentId);
  if (!payment) {
    log.warn('invoice requested for unknown payment', { paymentId });
    return { generated: false };
  }
  const merchant = await merchantRepository.findById(payment.merchant);

  const netMinor = payment.amountMinor - (payment.feeMinor ?? 0);
  const invoice = {
    invoiceId: ids.invoiceId(),
    paymentId,
    issuedAt: new Date().toISOString(),
    merchant: { merchantId: merchant.merchantId, name: merchant.name, country: merchant.country },
    customer: {
      email: payment.customer?.email ?? null,
      customerId: payment.customer?.customerId ?? null,
    },
    lines: [
      {
        description: payment.description ?? `Payment ${paymentId}`,
        amountMinor: payment.amountMinor,
        amount: money.toMajorString(payment.amountMinor, payment.currency),
      },
      {
        description: 'Processing fee',
        amountMinor: -(payment.feeMinor ?? 0),
        amount: money.toMajorString(-(payment.feeMinor ?? 0), payment.currency),
      },
    ],
    currency: payment.currency,
    totalMinor: payment.amountMinor,
    total: money.toMajorString(payment.amountMinor, payment.currency),
    netMinor,
    net: money.toMajorString(netMinor, payment.currency),
  };

  log.info('invoice generated', { invoiceId: invoice.invoiceId, paymentId });
  return invoice;
}

module.exports = { process };
