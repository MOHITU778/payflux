'use strict';

const config = require('../config');
const logger = require('../config/logger');
const ids = require('../utils/ids');
const money = require('../utils/money');
const pagination = require('../utils/pagination');
const { settlementRepository, paymentRepository, merchantRepository } = require('../repositories');
const { SETTLEMENT_STATUS, EVENT, AUDIT_ACTION } = require('../constants');
const { NotFoundError, BusinessRuleError } = require('../errors');
const lockService = require('./lock.service');
const acquirer = require('./acquirer.service');
const auditService = require('./audit.service');
const producers = require('../queues/producers');

/**
 * Settlement (payout) pipeline.
 *
 * ── Lifecycle ──────────────────────────────────────────────────────────────
 *   build   — sweep captured payments past their hold window into a batch
 *   execute — instruct the bank payout, then post the ledger journal
 *
 * ── Why a batch key ────────────────────────────────────────────────────────
 * `batchKey` is deterministic on (merchant, currency, window) and carries a
 * unique index. The scheduler runs every 6 hours, an operator can trigger a run
 * manually, and a retried job may re-enter — all three converge on the same key
 * and only one batch is ever created. Paying a merchant twice for the same
 * window is the failure mode this exists to prevent.
 *
 * ── Claiming payments ──────────────────────────────────────────────────────
 * Payments are attached to the batch with a conditional update that requires
 * `settlement: null`. A payment can therefore belong to exactly one batch even
 * if two builds race — the second finds nothing left to claim.
 */
class SettlementService {
  constructor(deps = {}) {
    this.settlements = deps.settlementRepository ?? settlementRepository;
    this.payments = deps.paymentRepository ?? paymentRepository;
    this.merchants = deps.merchantRepository ?? merchantRepository;
    this.lock = deps.lockService ?? lockService;
    this.acquirer = deps.acquirer ?? acquirer;
    this.audit = deps.auditService ?? auditService;
    this.producers = deps.producers ?? producers;
    this.log = logger.child({ component: 'settlement-service' });
  }

  /**
   * Build a settlement batch for one merchant and currency.
   * @returns {Promise<object|null>} the batch, or null when nothing is due.
   */
  async buildBatch({ merchantId, currency, now = new Date() }) {
    const merchant = await this.merchants.findByMerchantId(merchantId);
    if (!merchant) throw new NotFoundError('Merchant');

    const holdHours = merchant.settlementConfig?.holdHours ?? config.settlement.holdHours;
    const cutoff = new Date(now.getTime() - holdHours * 60 * 60 * 1000);
    const batchKey = this.batchKey(merchantId, currency, cutoff);

    // Lock per merchant/currency so two schedulers cannot build concurrently.
    return this.lock.withLock(`settlement:${merchantId}:${currency}`, async () => {
      const existing = await this.settlements.findByBatchKey(batchKey);
      if (existing) {
        this.log.info('settlement batch already exists for window', { batchKey });
        return existing;
      }

      const eligible = await this.payments.findSettleable(merchant._id, { currency, before: cutoff });
      if (!eligible.length) {
        this.log.debug('no settleable payments', { merchantId, currency });
        return null;
      }

      // Gross is what was captured; refunds already applied to those payments
      // reduce the payout, and the platform fee is deducted.
      const grossAmountMinor = money.sum(eligible.map((p) => p.amountMinor));
      const refundedAmountMinor = money.sum(eligible.map((p) => p.amountRefundedMinor ?? 0));
      const feeAmountMinor = money.sum(eligible.map((p) => p.feeMinor ?? 0));
      const netAmountMinor = grossAmountMinor - refundedAmountMinor - feeAmountMinor;

      if (netAmountMinor <= 0) {
        // Refunds exceeded captures in this window. There is nothing to pay
        // out; the negative balance stays on the merchant's payable account
        // and nets off against the next window.
        this.log.warn('settlement window nets to zero or below, skipping payout', {
          merchantId, currency, grossAmountMinor, refundedAmountMinor, feeAmountMinor,
        });
        return null;
      }

      const settlementId = ids.settlementId();
      const periodStart = eligible[0].completedAt ?? eligible[0].createdAt;

      const settlement = await this.settlements.create({
        settlementId,
        merchant: merchant._id,
        currency,
        periodStart,
        periodEnd: cutoff,
        grossAmountMinor,
        refundedAmountMinor,
        feeAmountMinor,
        netAmountMinor,
        paymentCount: eligible.length,
        status: SETTLEMENT_STATUS.QUEUED,
        payout: { bankAccountLast4: merchant.settlementConfig?.bankAccountLast4 ?? null },
        batchKey,
      });

      // Claim the payments. `settlement: null` in the filter is what makes a
      // payment un-stealable by a concurrent batch.
      const claimed = await this.payments.updateMany(
        { _id: { $in: eligible.map((p) => p._id) }, settlement: null },
        { $set: { settlement: settlement._id, settledAt: null } },
      );

      this.log.info('settlement batch built', {
        settlementId, merchantId, currency, netAmountMinor,
        paymentCount: eligible.length, claimed: claimed.modifiedCount,
      });

      this.producers.emitPaymentEvent(EVENT.SETTLEMENT_CREATED, {
        settlementId, merchantId, netAmountMinor, currency,
      }).catch(() => {});
      this.producers.executeSettlement(settlementId).catch((err) =>
        this.log.error('failed to enqueue settlement execution', { settlementId, error: err.message }));

      return settlement;
    });
  }

  /**
   * Instruct the payout and mark the batch settled.
   * Idempotent — a redelivered job finds the batch already SETTLED and stops.
   */
  async execute(settlementId) {
    const settlement = await this.settlements.findBySettlementId(settlementId);
    if (!settlement) throw new NotFoundError('Settlement');
    if (settlement.status === SETTLEMENT_STATUS.SETTLED) {
      this.log.info('settlement already completed', { settlementId });
      return settlement;
    }

    // CAS into PROCESSING: only one worker may instruct the bank.
    const claimed = await this.settlements.transition(
      settlementId,
      [SETTLEMENT_STATUS.QUEUED, SETTLEMENT_STATUS.FAILED],
      SETTLEMENT_STATUS.PROCESSING,
      { 'payout.initiatedAt': new Date() },
    );
    if (!claimed) {
      this.log.warn('settlement already claimed by another worker', { settlementId });
      return this.settlements.findBySettlementId(settlementId);
    }

    try {
      const payout = await this.acquirer.payout({
        settlementId,
        netAmountMinor: settlement.netAmountMinor,
        currency: settlement.currency,
      });

      const settled = await this.settlements.transition(
        settlementId,
        SETTLEMENT_STATUS.PROCESSING,
        SETTLEMENT_STATUS.SETTLED,
        { 'payout.reference': payout.reference, 'payout.completedAt': new Date() },
      );

      await this.payments.updateMany(
        { settlement: settlement._id },
        { $set: { settledAt: new Date() } },
      );

      this.log.info('settlement executed', {
        settlementId, netAmountMinor: settlement.netAmountMinor, reference: payout.reference,
      });

      Promise.allSettled([
        this.producers.postSettlementToLedger(settlementId),
        this.producers.emitPaymentEvent(EVENT.SETTLEMENT_COMPLETED, {
          settlementId,
          netAmountMinor: settlement.netAmountMinor,
          currency: settlement.currency,
        }),
      ]).catch(() => {});

      this.audit.record({
        action: AUDIT_ACTION.SETTLEMENT_RUN,
        outcome: 'SUCCESS',
        actor: { userId: null, role: 'system' },
        merchant: settlement.merchant,
        target: { type: 'Settlement', id: settlementId },
        metadata: { netAmountMinor: settlement.netAmountMinor },
      });

      return settled;
    } catch (err) {
      // Back to FAILED, which the retry scheduler re-drives. The payments stay
      // claimed by this batch, so they are never double-paid by another one.
      await this.settlements.transition(
        settlementId,
        SETTLEMENT_STATUS.PROCESSING,
        SETTLEMENT_STATUS.FAILED,
        { 'failure.code': err.code ?? 'PAYOUT_FAILED', 'failure.message': err.message },
      );
      // Attempt counter is a separate update: `transition` builds a `$set`, and
      // an operator key cannot be nested inside one.
      await this.settlements.updateOne({ settlementId }, { $inc: { 'failure.attempts': 1 } });
      this.log.error('settlement execution failed', { settlementId, error: err.message });
      throw err;
    }
  }

  /** Sweep every auto-settle merchant. Invoked by the settlement cron. */
  async runScheduledSweep() {
    const merchants = await this.merchants.findAutoSettleable();
    this.log.info('settlement sweep starting', { merchantCount: merchants.length });

    const results = await Promise.allSettled(
      merchants.map((merchant) =>
        this.producers.buildSettlement(merchant.merchantId, merchant.defaultCurrency)),
    );

    const queued = results.filter((result) => result.status === 'fulfilled').length;
    this.log.info('settlement sweep queued', { queued, total: merchants.length });
    return { merchants: merchants.length, queued };
  }

  /**
   * Deterministic batch identity.
   * The window is truncated to the hour so a scheduler that fires at 06:00:03
   * and a manual retry at 06:04:11 produce the same key.
   */
  batchKey(merchantId, currency, cutoff) {
    return `${merchantId}:${currency}:${cutoff.toISOString().slice(0, 13)}`;
  }

  async getSettlement({ merchant, settlementId }) {
    const filter = merchant ? { settlementId, merchant: merchant._id } : { settlementId };
    const settlement = await this.settlements.findOne(filter);
    if (!settlement) throw new NotFoundError('Settlement');
    return this.toViewModel(settlement);
  }

  async listSettlements({ merchantFilter, query }) {
    const { page, limit } = pagination.normalize(query);
    const filter = { ...merchantFilter };
    if (query.status) filter.status = query.status;
    if (query.currency) filter.currency = query.currency;
    const result = await this.settlements.paginate(filter, { page, limit, sort: { createdAt: -1 } });
    return { ...result, items: result.items.map((item) => this.toViewModel(item)) };
  }

  async queue(merchantFilter) {
    const pending = await this.settlements.pendingQueue(merchantFilter);
    return pending.map((item) => this.toViewModel(item));
  }

  /** Manual trigger from the admin console. */
  async triggerManual({ merchantId, currency, actor }) {
    const merchant = await this.merchants.findByMerchantId(merchantId);
    if (!merchant) throw new NotFoundError('Merchant');
    if (merchant.status !== 'ACTIVE') {
      throw new BusinessRuleError('Merchant is not active', 'MERCHANT_INACTIVE');
    }
    this.audit.record({
      action: AUDIT_ACTION.SETTLEMENT_RUN,
      outcome: 'SUCCESS',
      actor,
      merchant: merchant._id,
      metadata: { trigger: 'manual', currency },
    });
    return this.buildBatch({ merchantId, currency: currency ?? merchant.defaultCurrency });
  }

  toViewModel(settlement) {
    if (!settlement) return null;
    const currency = settlement.currency;
    return {
      settlementId: settlement.settlementId,
      status: settlement.status,
      currency,
      grossAmountMinor: settlement.grossAmountMinor,
      gross: money.toMajorString(settlement.grossAmountMinor, currency),
      refundedAmountMinor: settlement.refundedAmountMinor,
      refunded: money.toMajorString(settlement.refundedAmountMinor, currency),
      feeAmountMinor: settlement.feeAmountMinor,
      fee: money.toMajorString(settlement.feeAmountMinor, currency),
      netAmountMinor: settlement.netAmountMinor,
      net: money.toMajorString(settlement.netAmountMinor, currency),
      paymentCount: settlement.paymentCount,
      periodStart: settlement.periodStart,
      periodEnd: settlement.periodEnd,
      payout: settlement.payout,
      failure: settlement.failure?.code ? settlement.failure : null,
      merchant: settlement.merchant?.merchantId
        ? { merchantId: settlement.merchant.merchantId, name: settlement.merchant.name }
        : undefined,
      createdAt: settlement.createdAt,
    };
  }
}

module.exports = new SettlementService();
module.exports.SettlementService = SettlementService;
