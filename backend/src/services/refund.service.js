'use strict';

const logger = require('../config/logger');
const ids = require('../utils/ids');
const money = require('../utils/money');
const pagination = require('../utils/pagination');
const requestContext = require('../utils/requestContext');
const { refundRepository, paymentRepository, merchantRepository } = require('../repositories');
const { PAYMENT_STATUS, REFUND_STATUS, EVENT, AUDIT_ACTION } = require('../constants');
const { NotFoundError, BusinessRuleError } = require('../errors');
const { refundStateMachine } = require('./stateMachine.service');
const lockService = require('./lock.service');
const acquirer = require('./acquirer.service');
const auditService = require('./audit.service');
const producers = require('../queues/producers');

/**
 * Refund processing.
 *
 * ── The over-refund problem ────────────────────────────────────────────────
 * Two ₹600 refunds against a ₹1,000 payment must not both succeed. Naively,
 * each request reads `amountRefunded = 0`, decides 600 ≤ 1000, and writes.
 * Three independent defences stop that here:
 *
 *   1. A distributed lock on `payment:<id>` serialises refund requests for the
 *      same payment across all API replicas.
 *   2. The eligibility check counts *committed* refunds — including PENDING and
 *      PROCESSING ones — so an in-flight refund reserves its amount.
 *   3. `applyRefund` uses a conditional `$expr` update: the database itself
 *      refuses to let the refunded total exceed the captured amount. Even if
 *      both earlier layers failed, the write is rejected.
 *
 * Layer 3 is the one that actually guarantees correctness; 1 and 2 exist so
 * the common case returns a clean error instead of a lost race.
 */
class RefundService {
  constructor(deps = {}) {
    this.refunds = deps.refundRepository ?? refundRepository;
    this.payments = deps.paymentRepository ?? paymentRepository;
    this.merchants = deps.merchantRepository ?? merchantRepository;
    this.lock = deps.lockService ?? lockService;
    this.acquirer = deps.acquirer ?? acquirer;
    this.audit = deps.auditService ?? auditService;
    this.stateMachine = deps.stateMachine ?? refundStateMachine;
    this.producers = deps.producers ?? producers;
    this.log = logger.child({ component: 'refund-service' });
  }

  /**
   * Initiate a full or partial refund.
   *
   * @param {object} params
   * @param {object} params.merchant
   * @param {string} params.paymentId
   * @param {number} [params.amountMinor]  Omit for a full refund of the remaining balance.
   * @returns {Promise<object>} refund view model
   */
  async createRefund({ merchant, paymentId, amountMinor, reason, notes, actor = {}, idempotencyKey = null }) {
    // ── Defence 1: serialise refunds for this payment ────────────────────
    return this.lock.withLock(`payment:${paymentId}`, async () => {
      const payment = await this.payments.findForMerchant(paymentId, merchant._id);
      if (!payment) throw new NotFoundError('Payment');

      if (![PAYMENT_STATUS.SUCCESS, PAYMENT_STATUS.PARTIALLY_REFUNDED].includes(payment.status)) {
        throw new BusinessRuleError(
          `Only captured payments can be refunded (current status: ${payment.status})`,
          'PAYMENT_NOT_REFUNDABLE',
          { status: payment.status },
        );
      }

      // ── Defence 2: committed refunds reserve their amount ──────────────
      const committed = await this.refunds.committedAmountMinor(payment._id);
      const available = payment.amountMinor - committed;

      const requested = amountMinor ?? available;
      money.assertMinor(requested);

      if (requested <= 0) {
        throw new BusinessRuleError('Refund amount must be greater than zero', 'INVALID_REFUND_AMOUNT');
      }
      if (requested > available) {
        throw new BusinessRuleError(
          `Refund of ${requested} exceeds the refundable balance of ${available}`,
          'REFUND_EXCEEDS_BALANCE',
          { requestedMinor: requested, availableMinor: available, alreadyCommittedMinor: committed },
        );
      }

      const refundId = ids.refundId();
      const refund = await this.refunds.create({
        refundId,
        payment: payment._id,
        paymentId,
        merchant: merchant._id,
        amountMinor: requested,
        currency: payment.currency,
        status: REFUND_STATUS.PENDING,
        isFullRefund: requested === available && committed === 0,
        reason: reason ?? 'REQUESTED_BY_CUSTOMER',
        notes: notes ?? null,
        idempotencyKey,
        initiatedBy: actor.userId ?? null,
      });

      this.audit.record({
        action: AUDIT_ACTION.REFUND_CREATE,
        outcome: 'SUCCESS',
        actor,
        merchant: merchant._id,
        target: { type: 'Refund', id: refundId },
        metadata: { paymentId, amountMinor: requested },
      });

      this.producers
        .emitPaymentEvent(EVENT.REFUND_INITIATED, {
          refundId, paymentId, merchantId: merchant.merchantId, amountMinor: requested,
        })
        .catch((err) => this.log.error('failed to emit refund event', { error: err.message }));

      // Execute inline so the caller gets a resolved state; the worker path
      // exists for retries when this attempt cannot complete.
      const processed = await this.process(refundId).catch((err) => {
        this.log.error('inline refund processing failed, leaving for retry', {
          refundId, error: err.message,
        });
        return { ...refund, status: REFUND_STATUS.PENDING };
      });

      return this.toViewModel(processed, payment);
    });
  }

  /**
   * Execute a pending refund against the acquirer and update the payment.
   *
   * Idempotent: a redelivered job finds the refund already SUCCESS and returns
   * it untouched rather than refunding twice.
   */
  async process(refundId) {
    const refund = await this.refunds.findByRefundId(refundId);
    if (!refund) throw new NotFoundError('Refund');

    if (refund.status === REFUND_STATUS.SUCCESS) {
      this.log.info('refund already settled, skipping', { refundId });
      return refund;
    }
    this.stateMachine.assertTransition(refund.status, REFUND_STATUS.PROCESSING, 'Refund');

    const processing = await this.refunds.updateOne(
      { refundId, status: REFUND_STATUS.PENDING },
      { $set: { status: REFUND_STATUS.PROCESSING } },
    );
    if (!processing) {
      // Another worker claimed it; return whatever it settled on.
      return this.refunds.findByRefundId(refundId);
    }

    try {
      const response = await this.acquirer.refund({
        refundId,
        paymentId: refund.paymentId,
        amountMinor: refund.amountMinor,
        currency: refund.currency,
      });

      // ── Defence 3: the database refuses to over-refund ────────────────
      const updatedPayment = await this.payments.applyRefund(refund.paymentId, refund.amountMinor);
      if (!updatedPayment) {
        // The conditional update matched nothing: the payment is no longer
        // refundable, or this refund would breach the captured amount.
        await this.refunds.updateOne(
          { refundId },
          {
            $set: {
              status: REFUND_STATUS.FAILED,
              'failure.code': 'REFUND_LIMIT_BREACHED',
              'failure.message': 'Refund would exceed the captured amount',
              processedAt: new Date(),
            },
          },
        );
        throw new BusinessRuleError(
          'Refund rejected: it would exceed the captured amount',
          'REFUND_LIMIT_BREACHED',
        );
      }

      const settled = await this.refunds.updateOne(
        { refundId, status: REFUND_STATUS.PROCESSING },
        {
          $set: {
            status: REFUND_STATUS.SUCCESS,
            acquirerReferenceId: response.referenceId,
            processedAt: new Date(),
          },
        },
      );

      this.log.info('refund settled', {
        refundId, paymentId: refund.paymentId, amountMinor: refund.amountMinor,
        paymentStatus: updatedPayment.status,
      });

      // Ledger posting and merchant notification happen asynchronously.
      Promise.allSettled([
        this.producers.postRefundToLedger(refundId),
        this.producers.emitPaymentEvent(EVENT.REFUND_SUCCEEDED, {
          refundId,
          paymentId: refund.paymentId,
          amountMinor: refund.amountMinor,
        }),
      ]).catch(() => {});

      return settled;
    } catch (err) {
      if (err.retryable) {
        // Put it back to PENDING so the retry scheduler picks it up. Marking it
        // FAILED here would strand a refund the acquirer may have accepted.
        await this.refunds.updateOne(
          { refundId },
          { $set: { status: REFUND_STATUS.PENDING, 'failure.message': err.message } },
        );
        throw err;
      }
      await this.refunds.updateOne(
        { refundId, status: REFUND_STATUS.PROCESSING },
        {
          $set: {
            status: REFUND_STATUS.FAILED,
            'failure.code': err.code ?? 'REFUND_FAILED',
            'failure.message': err.message,
            processedAt: new Date(),
          },
        },
      );
      this.producers.emitPaymentEvent(EVENT.REFUND_FAILED, { refundId, reason: err.message }).catch(() => {});
      throw err;
    }
  }

  async getRefund({ merchant, refundId }) {
    const refund = await this.refunds.findOne({ refundId, merchant: merchant._id });
    if (!refund) throw new NotFoundError('Refund');
    return this.toViewModel(refund);
  }

  async listRefunds({ merchantFilter, query }) {
    const { page, limit } = pagination.normalize(query);
    const filter = { ...merchantFilter };
    if (query.status) filter.status = query.status;
    if (query.paymentId) filter.paymentId = query.paymentId;
    if (query.from || query.to) {
      filter.createdAt = {};
      if (query.from) filter.createdAt.$gte = new Date(query.from);
      if (query.to) filter.createdAt.$lte = new Date(query.to);
    }
    const result = await this.refunds.paginate(filter, { page, limit, sort: { createdAt: -1 } });
    return { ...result, items: result.items.map((refund) => this.toViewModel(refund)) };
  }

  toViewModel(refund, payment) {
    if (!refund) return null;
    return {
      refundId: refund.refundId,
      paymentId: refund.paymentId,
      status: refund.status,
      amountMinor: refund.amountMinor,
      amount: money.toMajorString(refund.amountMinor, refund.currency),
      currency: refund.currency,
      isFullRefund: refund.isFullRefund,
      reason: refund.reason,
      notes: refund.notes,
      failure: refund.failure?.code ? refund.failure : null,
      acquirerReferenceId: refund.acquirerReferenceId,
      paymentStatus: payment?.status,
      createdAt: refund.createdAt,
      processedAt: refund.processedAt,
      correlationId: requestContext.get('correlationId'),
    };
  }
}

module.exports = new RefundService();
module.exports.RefundService = RefundService;
