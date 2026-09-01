'use strict';

const logger = require('../config/logger');
const ledgerService = require('../services/ledger.service');
const {
  paymentRepository, refundRepository, settlementRepository, merchantRepository,
} = require('../repositories');
const { AppError } = require('../errors');

/**
 * A referenced entity that does not exist is a *permanent* condition — it will
 * never appear on a later attempt. Throwing a non-retryable error sends the job
 * straight to the dead-letter queue instead of burning ten exponential-backoff
 * retries over several minutes, which only delays the operator seeing it.
 */
function missing(kind, id) {
  return new AppError(`${kind} ${id} not found for ledger posting`, {
    status: 404,
    code: 'LEDGER_REFERENCE_MISSING',
    retryable: false,
    details: { kind, id },
  });
}

/**
 * Ledger posting worker.
 *
 * Financial writes are moved off the request path but must never be lost, so
 * this queue carries the highest retry budget in the system and failed jobs are
 * never auto-removed.
 *
 * Idempotency is inherited from `LedgerService.postJournal`, whose deterministic
 * journal key is protected by a unique index — a redelivered job returns the
 * original journal rather than posting a second one. That property is what
 * makes at-least-once delivery safe for money.
 */

const log = logger.child({ component: 'worker:ledger' });

async function process(job) {
  const { paymentId, refundId, settlementId } = job.data;

  switch (job.name) {
    case 'ledger.payment.capture': {
      const payment = await paymentRepository.findByPaymentId(paymentId);
      if (!payment) throw missing('Payment', paymentId);
      const merchant = await merchantRepository.findById(payment.merchant);

      const result = await ledgerService.recordPaymentCapture({ payment, merchant });
      log.info('capture posted', {
        paymentId, journalId: result.journal.journalId, replayed: result.replayed,
      });
      return { journalId: result.journal.journalId, replayed: result.replayed };
    }

    case 'ledger.refund.settle': {
      const refund = await refundRepository.findByRefundId(refundId);
      if (!refund) throw missing('Refund', refundId);
      const merchant = await merchantRepository.findById(refund.merchant);

      const result = await ledgerService.recordRefund({ refund, merchant });
      log.info('refund posted', {
        refundId, journalId: result.journal.journalId, replayed: result.replayed,
      });
      return { journalId: result.journal.journalId, replayed: result.replayed };
    }

    case 'ledger.settlement.payout': {
      const settlement = await settlementRepository.findBySettlementId(settlementId);
      if (!settlement) throw missing('Settlement', settlementId);
      const merchant = await merchantRepository.findById(settlement.merchant);

      const result = await ledgerService.recordSettlement({ settlement, merchant });
      await settlementRepository.updateOne(
        { settlementId },
        { $set: { journalId: result.journal.journalId } },
      );
      log.info('settlement posted', { settlementId, journalId: result.journal.journalId });
      return { journalId: result.journal.journalId, replayed: result.replayed };
    }

    default:
      throw new Error(`Unknown ledger job: ${job.name}`);
  }
}

module.exports = { process };
