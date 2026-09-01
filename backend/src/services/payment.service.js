'use strict';

const config = require('../config');
const logger = require('../config/logger');
const metrics = require('../config/metrics');
const ids = require('../utils/ids');
const money = require('../utils/money');
const pagination = require('../utils/pagination');
const requestContext = require('../utils/requestContext');
const { paymentRepository, merchantRepository, transactionRepository } = require('../repositories');
const { PAYMENT_STATUS, FRAUD_DECISION, EVENT, AUDIT_ACTION } = require('../constants');
const { NotFoundError, BusinessRuleError, FraudBlockedError } = require('../errors');
const { paymentStateMachine } = require('./stateMachine.service');
const lockService = require('./lock.service');
const fraudService = require('./fraud/fraud.service');
const acquirer = require('./acquirer.service');
const auditService = require('./audit.service');
const producers = require('../queues/producers');

/**
 * Payment orchestration.
 *
 * ── Ordering of the critical section ───────────────────────────────────────
 * The sequence below is not arbitrary; each step exists to close a specific
 * failure mode:
 *
 *   1. Idempotency claim  (middleware, before we get here) — a retry must not
 *      produce a second charge.
 *   2. Risk evaluation — a blocked payment must never reach the acquirer, so
 *      scoring happens *before* the record is created in an actionable state.
 *   3. Persist as PENDING — the payment exists durably before any money moves.
 *      If we crashed after authorising but before persisting, we would have
 *      taken funds we have no record of. Persist-first makes the worst case a
 *      stuck PENDING (recoverable) rather than an orphaned charge.
 *   4. Authorise at the acquirer.
 *   5. CAS the outcome — concurrent writers cannot both win.
 *   6. Emit events — ledger, webhooks, notifications all happen asynchronously.
 *
 * ── Locking ────────────────────────────────────────────────────────────────
 * Creation does not need a distributed lock (the idempotency key already
 * serialises retries of the same logical request). Mutations of an *existing*
 * payment — cancel, refund — do, because two operators or two retries can
 * legitimately target the same payment id at the same moment.
 */
class PaymentService {
  constructor(deps = {}) {
    this.payments = deps.paymentRepository ?? paymentRepository;
    this.merchants = deps.merchantRepository ?? merchantRepository;
    this.transactions = deps.transactionRepository ?? transactionRepository;
    this.fraud = deps.fraudService ?? fraudService;
    this.acquirer = deps.acquirer ?? acquirer;
    this.lock = deps.lockService ?? lockService;
    this.stateMachine = deps.stateMachine ?? paymentStateMachine;
    this.producers = deps.producers ?? producers;
    this.audit = deps.auditService ?? auditService;
    this.log = logger.child({ component: 'payment-service' });
  }

  // ── Create ─────────────────────────────────────────────────────────────

  /**
   * Create and attempt a payment.
   *
   * @param {object} params
   * @param {object} params.merchant       Authenticated merchant document.
   * @param {object} params.dto            Validated CreatePaymentDto.
   * @param {object} params.actor          { userId, ipAddress, userAgent }
   * @param {string} [params.idempotencyKey]
   * @returns {Promise<object>} the payment view model
   */
  async createPayment({ merchant, dto, actor = {}, idempotencyKey = null }) {
    const paymentId = ids.paymentId();
    money.assertMinor(dto.amountMinor);

    if (dto.amountMinor <= 0) {
      throw new BusinessRuleError('Payment amount must be greater than zero', 'INVALID_AMOUNT');
    }

    const context = {
      ipAddress: actor.ipAddress ?? null,
      country: dto.context?.country ?? actor.country ?? null,
      userAgent: actor.userAgent ?? null,
      deviceFingerprint: dto.context?.deviceFingerprint ?? null,
    };

    // ── Step 2: risk. Evaluated before the acquirer sees anything. ───────
    const risk = await this.fraud.evaluate({
      merchant,
      attempt: {
        paymentId,
        amountMinor: dto.amountMinor,
        currency: dto.currency,
        customer: dto.customer ?? {},
        context,
      },
    });

    // ── Step 3: persist. The payment exists before money moves. ──────────
    const feeMinor = this.calculateFee(merchant, dto.amountMinor);
    const payment = await this.payments.create({
      paymentId,
      merchant: merchant._id,
      amountMinor: dto.amountMinor,
      currency: dto.currency,
      feeMinor,
      method: dto.method,
      status: PAYMENT_STATUS.PENDING,
      customer: dto.customer ?? {},
      context,
      risk: {
        score: risk.riskScore,
        decision: risk.decision,
        triggeredRules: risk.triggeredRules.map((rule) => rule.ruleId),
      },
      idempotencyKey,
      description: dto.description ?? null,
      notes: dto.notes,
      stateHistory: [{
        from: 'NONE',
        to: PAYMENT_STATUS.PENDING,
        reason: 'Payment created',
        actor: actor.userId ?? 'api',
        correlationId: requestContext.get('correlationId') ?? null,
        at: new Date(),
      }],
    });

    this.fraud.attachPayment(risk.fraudLogId, paymentId).catch(() => {});

    // A blocked payment is failed immediately and never sent upstream.
    if (risk.decision === FRAUD_DECISION.BLOCK) {
      await this.fail(paymentId, {
        code: 'FRAUD_BLOCKED',
        message: 'Blocked by risk engine',
        from: PAYMENT_STATUS.PENDING,
      });
      this.producers.emitPaymentEvent(EVENT.FRAUD_BLOCKED, {
        paymentId, merchantId: merchant.merchantId, riskScore: risk.riskScore,
      }).catch((err) => this.log.error('failed to emit fraud event', { error: err.message }));

      metrics.paymentsTotal.inc({ status: 'BLOCKED', method: dto.method, currency: dto.currency });
      throw new FraudBlockedError(risk.riskScore, risk.triggeredRules.map((rule) => rule.ruleId));
    }

    // ── Steps 4–6 ────────────────────────────────────────────────────────
    const result = await this.authorizeAndCapture({ payment, merchant, actor });

    this.audit.record({
      action: AUDIT_ACTION.PAYMENT_CREATE,
      outcome: result.status === PAYMENT_STATUS.SUCCESS ? 'SUCCESS' : 'FAILURE',
      actor,
      merchant: merchant._id,
      target: { type: 'Payment', id: paymentId },
      metadata: { amountMinor: dto.amountMinor, currency: dto.currency, riskScore: risk.riskScore },
    });

    return this.toViewModel(result, merchant);
  }

  /**
   * Send the payment to the acquirer and record the outcome.
   *
   * Every exit path leaves the payment in a defined state: SUCCESS, FAILED, or
   * — when the acquirer itself is unreachable — PROCESSING, which the retry
   * scheduler will reconcile. A payment must never be left in a state nothing
   * will ever act on.
   */
  async authorizeAndCapture({ payment, merchant, actor = {} }) {
    const { paymentId, method, currency, amountMinor } = payment;

    // PENDING → PROCESSING. The CAS filter means a concurrent duplicate loses
    // here and never reaches the acquirer.
    const processing = await this.payments.transitionStatus(paymentId, {
      from: PAYMENT_STATUS.PENDING,
      to: PAYMENT_STATUS.PROCESSING,
      reason: 'Submitted to acquirer',
      actor: actor.userId ?? 'system',
      correlationId: requestContext.get('correlationId'),
    });

    if (!processing) {
      // Someone else already advanced it. Return the current truth rather than
      // charging again — this is the race the CAS exists to catch.
      this.log.warn('payment already advanced past PENDING', { paymentId });
      return this.payments.findByPaymentId(paymentId);
    }

    try {
      const authorization = await this.acquirer.authorize({
        paymentId,
        amountMinor,
        currency,
        method,
        customer: payment.customer,
      });

      if (!authorization.approved) {
        return this.fail(paymentId, {
          code: authorization.declineCode,
          message: authorization.declineMessage,
          from: PAYMENT_STATUS.PROCESSING,
          acquirerReferenceId: authorization.referenceId,
        });
      }

      const succeeded = await this.payments.transitionStatus(paymentId, {
        from: PAYMENT_STATUS.PROCESSING,
        to: PAYMENT_STATUS.SUCCESS,
        reason: 'Authorised and captured',
        actor: 'acquirer',
        correlationId: requestContext.get('correlationId'),
        extra: {
          'acquirer.name': this.acquirer.name,
          'acquirer.referenceId': authorization.referenceId,
          'acquirer.authCode': authorization.authCode,
          'acquirer.capturedAt': new Date(),
          'customer.network': authorization.network ?? payment.customer?.network ?? null,
        },
      });

      if (!succeeded) {
        this.log.warn('lost CAS on success transition', { paymentId });
        return this.payments.findByPaymentId(paymentId);
      }

      metrics.paymentsTotal.inc({ status: PAYMENT_STATUS.SUCCESS, method, currency });
      metrics.paymentAmountMinor.inc({ status: PAYMENT_STATUS.SUCCESS, currency }, amountMinor);

      // ── Step 6: the async pipeline takes over ────────────────────────
      this.emitSuccess({ payment: succeeded, merchant });
      return succeeded;
    } catch (err) {
      // The acquirer is unreachable or the circuit is open. We do NOT mark the
      // payment failed: the authorisation may well have succeeded upstream and
      // declaring it failed here would strand a real charge. It stays
      // PROCESSING for the reconciliation sweeper.
      if (err.retryable) {
        this.log.error('acquirer unavailable, leaving payment for reconciliation', {
          paymentId, error: err.message, code: err.code,
        });
        return this.payments.findByPaymentId(paymentId);
      }
      await this.fail(paymentId, {
        code: err.code ?? 'PROCESSING_ERROR',
        message: err.message,
        from: PAYMENT_STATUS.PROCESSING,
      });
      throw err;
    }
  }

  /** Publish every downstream consequence of a successful capture. */
  emitSuccess({ payment, merchant }) {
    const tasks = [
      this.producers.postPaymentToLedger(payment.paymentId),
      this.producers.emitPaymentEvent(EVENT.PAYMENT_SUCCEEDED, {
        paymentId: payment.paymentId,
        merchantId: merchant.merchantId,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
      }),
    ];
    // Fire-and-forget: a queue hiccup must not fail a payment the customer has
    // already been charged for. Failures are logged and swept up by the retry
    // scheduler, which re-drives any payment lacking a ledger journal.
    Promise.allSettled(tasks).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') {
          this.log.error('failed to publish post-payment job', {
            paymentId: payment.paymentId, error: result.reason?.message,
          });
        }
      }
    });
  }

  /** Terminal failure, with the decline reason preserved for analytics. */
  async fail(paymentId, { code, message, from, acquirerReferenceId }) {
    const failed = await this.payments.transitionStatus(paymentId, {
      from: from ?? [PAYMENT_STATUS.PENDING, PAYMENT_STATUS.PROCESSING, PAYMENT_STATUS.AUTHORIZED],
      to: PAYMENT_STATUS.FAILED,
      reason: message,
      actor: 'system',
      correlationId: requestContext.get('correlationId'),
      extra: {
        'failure.code': code,
        'failure.message': message,
        'failure.at': new Date(),
        ...(acquirerReferenceId ? { 'acquirer.referenceId': acquirerReferenceId } : {}),
      },
    });

    if (failed) {
      metrics.paymentsTotal.inc({
        status: PAYMENT_STATUS.FAILED, method: failed.method, currency: failed.currency,
      });
      this.producers
        .emitPaymentEvent(EVENT.PAYMENT_FAILED, { paymentId, failureCode: code })
        .catch(() => {});
    }
    return failed ?? this.payments.findByPaymentId(paymentId);
  }

  // ── Verify ─────────────────────────────────────────────────────────────

  /**
   * Verify a payment's current state.
   *
   * More than a read: when the payment is stuck in PROCESSING (we lost contact
   * with the acquirer mid-authorisation) this reconciles against the acquirer
   * and resolves it. That is what makes "verify" safe for a client to poll
   * after a timeout.
   */
  async verifyPayment({ merchant, paymentId, reconcile = true }) {
    const payment = await this.payments.findForMerchant(paymentId, merchant._id);
    if (!payment) throw new NotFoundError('Payment');

    if (reconcile && payment.status === PAYMENT_STATUS.PROCESSING && this.isStale(payment)) {
      this.log.info('reconciling stale payment with acquirer', { paymentId });
      return this.toViewModel(await this.reconcileWithAcquirer(payment, merchant), merchant);
    }

    return this.toViewModel(payment, merchant);
  }

  /** A PROCESSING payment older than 60s has outlived any normal authorisation. */
  isStale(payment, thresholdMs = 60_000) {
    return Date.now() - new Date(payment.updatedAt).getTime() > thresholdMs;
  }

  /**
   * Re-drive an indeterminate payment against the acquirer, under a lock so
   * two pollers cannot reconcile the same payment concurrently.
   */
  async reconcileWithAcquirer(payment, merchant) {
    return this.lock.withLock(`payment:${payment.paymentId}`, async () => {
      const current = await this.payments.findByPaymentId(payment.paymentId);
      if (current.status !== PAYMENT_STATUS.PROCESSING) return current; // resolved while we waited

      try {
        const authorization = await this.acquirer.authorize({
          paymentId: current.paymentId,
          amountMinor: current.amountMinor,
          currency: current.currency,
          method: current.method,
          customer: current.customer,
        });

        if (authorization.approved) {
          const succeeded = await this.payments.transitionStatus(current.paymentId, {
            from: PAYMENT_STATUS.PROCESSING,
            to: PAYMENT_STATUS.SUCCESS,
            reason: 'Resolved by reconciliation',
            actor: 'reconciler',
            extra: {
              'acquirer.referenceId': authorization.referenceId,
              'acquirer.authCode': authorization.authCode,
              'acquirer.capturedAt': new Date(),
            },
          });
          if (succeeded) this.emitSuccess({ payment: succeeded, merchant });
          return succeeded ?? current;
        }

        return this.fail(current.paymentId, {
          code: authorization.declineCode,
          message: authorization.declineMessage,
          from: PAYMENT_STATUS.PROCESSING,
        });
      } catch (err) {
        // Still unreachable. Leave it PROCESSING and try again later — never
        // guess at an outcome we cannot observe.
        this.log.warn('reconciliation inconclusive', { paymentId: current.paymentId, error: err.message });
        return current;
      }
    });
  }

  // ── Cancel ─────────────────────────────────────────────────────────────

  /**
   * Cancel a payment that has not yet been captured.
   * Held under a distributed lock: a cancel racing a capture must not produce
   * a payment that is both CANCELLED and SUCCESS.
   */
  async cancelPayment({ merchant, paymentId, reason, actor = {} }) {
    return this.lock.withLock(`payment:${paymentId}`, async () => {
      const payment = await this.payments.findForMerchant(paymentId, merchant._id);
      if (!payment) throw new NotFoundError('Payment');

      // The state machine is the single authority on whether this is legal.
      this.stateMachine.assertTransition(payment.status, PAYMENT_STATUS.CANCELLED);

      if (payment.status === PAYMENT_STATUS.AUTHORIZED) {
        await this.acquirer.cancel({ paymentId }); // void the authorisation upstream
      }

      const cancelled = await this.payments.transitionStatus(paymentId, {
        from: [PAYMENT_STATUS.PENDING, PAYMENT_STATUS.AUTHORIZED],
        to: PAYMENT_STATUS.CANCELLED,
        reason: reason ?? 'Cancelled by merchant',
        actor: actor.userId ?? 'merchant',
        correlationId: requestContext.get('correlationId'),
      });

      if (!cancelled) {
        throw new BusinessRuleError(
          'Payment changed state before it could be cancelled',
          'CANCEL_RACE_LOST',
        );
      }

      metrics.paymentsTotal.inc({
        status: PAYMENT_STATUS.CANCELLED, method: payment.method, currency: payment.currency,
      });
      this.producers.emitPaymentEvent(EVENT.PAYMENT_CANCELLED, {
        paymentId, merchantId: merchant.merchantId,
      }).catch(() => {});
      this.audit.record({
        action: AUDIT_ACTION.PAYMENT_CANCEL,
        outcome: 'SUCCESS',
        actor,
        merchant: merchant._id,
        target: { type: 'Payment', id: paymentId },
        reason,
      });

      return this.toViewModel(cancelled, merchant);
    });
  }

  // ── Reads ──────────────────────────────────────────────────────────────

  async getPayment({ merchant, paymentId }) {
    const payment = merchant
      ? await this.payments.findForMerchant(paymentId, merchant._id)
      : await this.payments.findByPaymentId(paymentId);
    if (!payment) throw new NotFoundError('Payment');
    return this.toViewModel(payment, merchant);
  }

  /** Paginated, filtered payment list. Admins may span merchants. */
  async listPayments({ merchantFilter, query }) {
    const { page, limit } = pagination.normalize(query);
    const sort = pagination.buildSort(query.sort, ['createdAt', 'amountMinor', 'status', 'completedAt']);

    const filter = { ...merchantFilter };
    if (query.status) filter.status = { $in: String(query.status).split(',') };
    if (query.method) filter.method = query.method;
    if (query.currency) filter.currency = query.currency;
    if (query.paymentId) filter.paymentId = query.paymentId;
    if (query.customerEmail) filter['customer.email'] = String(query.customerEmail).toLowerCase();
    if (query.minAmount || query.maxAmount) {
      filter.amountMinor = {};
      if (query.minAmount) filter.amountMinor.$gte = Number(query.minAmount);
      if (query.maxAmount) filter.amountMinor.$lte = Number(query.maxAmount);
    }
    if (query.from || query.to) {
      filter.createdAt = {};
      if (query.from) filter.createdAt.$gte = new Date(query.from);
      if (query.to) filter.createdAt.$lte = new Date(query.to);
    }

    const result = await this.payments.paginate(filter, { page, limit, sort });
    return { ...result, items: result.items.map((item) => this.toViewModel(item)) };
  }

  /** Chronological transaction feed for a merchant. */
  async transactionHistory({ merchantFilter, query }) {
    const { page, limit } = pagination.normalize(query);
    const result = await this.transactions.search(merchantFilter, {
      term: query.q,
      type: query.type,
      status: query.status,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      page,
      limit,
    });
    return {
      ...result,
      items: result.items.map((txn) => ({
        ...txn,
        amountFormatted: money.toMajorString(txn.amountMinor, txn.currency),
        netFormatted: money.toMajorString(txn.netMinor, txn.currency),
      })),
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /**
   * Platform fee, from the merchant's contracted basis-point rate.
   * Computed once at creation and frozen on the payment, so a later pricing
   * change cannot retroactively alter a settled transaction.
   */
  calculateFee(merchant, amountMinor) {
    const bps = merchant.settlementConfig?.platformFeeBps ?? config.settlement.platformFeeBps;
    return money.splitByBps(amountMinor, bps).fee;
  }

  /**
   * Shape a payment for the API.
   * Formatted amounts are added server-side so every client — Angular, a
   * merchant's backend, a support tool — renders money identically.
   */
  toViewModel(payment, merchant) {
    if (!payment) return null;
    const currency = payment.currency;
    const refunded = payment.amountRefundedMinor ?? 0;
    return {
      paymentId: payment.paymentId,
      status: payment.status,
      amountMinor: payment.amountMinor,
      amount: money.toMajorString(payment.amountMinor, currency),
      currency,
      feeMinor: payment.feeMinor,
      fee: money.toMajorString(payment.feeMinor ?? 0, currency),
      amountRefundedMinor: refunded,
      amountRefunded: money.toMajorString(refunded, currency),
      refundableMinor: Math.max(0, payment.amountMinor - refunded),
      method: payment.method,
      description: payment.description,
      customer: payment.customer,
      risk: payment.risk,
      acquirer: payment.acquirer
        ? { referenceId: payment.acquirer.referenceId, authCode: payment.acquirer.authCode }
        : null,
      failure: payment.failure?.code ? payment.failure : null,
      allowedTransitions: this.stateMachine.allowedFrom(payment.status),
      merchantId: merchant?.merchantId,
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,
      completedAt: payment.completedAt,
      stateHistory: payment.stateHistory,
    };
  }
}

module.exports = new PaymentService();
module.exports.PaymentService = PaymentService;
