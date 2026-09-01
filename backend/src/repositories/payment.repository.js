'use strict';

const BaseRepository = require('./base.repository');
const { Payment } = require('../models');
const { PAYMENT_STATUS } = require('../constants');

class PaymentRepository extends BaseRepository {
  constructor() { super(Payment); }

  findByPaymentId(paymentId, opts = {}) {
    return this.findOne({ paymentId }, opts);
  }

  /** Tenant-scoped lookup: a merchant can only ever address its own payments. */
  findForMerchant(paymentId, merchantObjectId, opts = {}) {
    return this.findOne({ paymentId, merchant: merchantObjectId }, opts);
  }

  findByIdempotencyKey(merchantObjectId, idempotencyKey) {
    return this.findOne({ merchant: merchantObjectId, idempotencyKey });
  }

  /**
   * Compare-and-swap the payment status.
   *
   * The filter asserts the *expected* current status, so two concurrent workers
   * racing to mark the same payment SUCCESS produce exactly one winner: the
   * loser's filter no longer matches and it gets `null` back. This is the
   * database-level complement to the Redis lock — the lock prevents the race in
   * the common case, this makes a lost lock non-catastrophic.
   *
   * @returns {Promise<object|null>} the updated payment, or null if the CAS lost.
   */
  async transitionStatus(paymentId, { from, to, reason, actor, correlationId, extra = {} }) {
    const expected = Array.isArray(from) ? from : [from];
    return this.updateOne(
      { paymentId, status: { $in: expected } },
      {
        $set: {
          status: to,
          ...extra,
          ...(TERMINAL.includes(to) ? { completedAt: new Date() } : {}),
        },
        $push: {
          stateHistory: {
            from: expected.length === 1 ? expected[0] : 'NONE',
            to,
            reason: reason ?? null,
            actor: actor ?? 'system',
            correlationId: correlationId ?? null,
            at: new Date(),
          },
        },
      },
    );
  }

  /**
   * Atomically record a refund against the payment.
   *
   * `amountRefundedMinor` is incremented with `$inc` and guarded by an
   * `$expr` so the total can never exceed the captured amount, even if two
   * refund workers execute concurrently. Without the guard, two half-refunds
   * racing could each read "0 refunded" and both succeed.
   */
  async applyRefund(paymentId, amountMinor, session) {
    return this.updateOne(
      {
        paymentId,
        status: { $in: [PAYMENT_STATUS.SUCCESS, PAYMENT_STATUS.PARTIALLY_REFUNDED] },
        $expr: { $lte: [{ $add: ['$amountRefundedMinor', amountMinor] }, '$amountMinor'] },
      },
      [
        {
          $set: {
            amountRefundedMinor: { $add: ['$amountRefundedMinor', amountMinor] },
            status: {
              $cond: [
                { $eq: [{ $add: ['$amountRefundedMinor', amountMinor] }, '$amountMinor'] },
                PAYMENT_STATUS.REFUNDED,
                PAYMENT_STATUS.PARTIALLY_REFUNDED,
              ],
            },
          },
        },
      ],
      { session },
    );
  }

  /** Payments eligible for a settlement batch: captured, held long enough, unsettled. */
  findSettleable(merchantObjectId, { currency, before, limit = 1000 }) {
    return this.find(
      {
        merchant: merchantObjectId,
        currency,
        status: { $in: [PAYMENT_STATUS.SUCCESS, PAYMENT_STATUS.PARTIALLY_REFUNDED] },
        settlement: null,
        completedAt: { $lte: before },
      },
      { sort: { completedAt: 1 }, limit },
    );
  }

  /** Count of recent attempts from one signal — the fraud engine's velocity probe. */
  countRecent(filter, sinceMs) {
    return this.count({ ...filter, createdAt: { $gte: new Date(Date.now() - sinceMs) } });
  }

  /**
   * Dashboard headline metrics in a single round trip.
   *
   * `$facet` runs the independent sub-aggregations over one pass of the same
   * matched set, so six tiles cost one query rather than six.
   */
  async dashboardStats(merchantFilter, { from, to }) {
    const match = { ...merchantFilter, createdAt: { $gte: from, $lte: to } };
    const [result] = await this.aggregate([
      { $match: match },
      {
        $facet: {
          byStatus: [
            { $group: { _id: '$status', count: { $sum: 1 }, amountMinor: { $sum: '$amountMinor' } } },
          ],
          totals: [
            {
              $group: {
                _id: null,
                count: { $sum: 1 },
                grossMinor: { $sum: '$amountMinor' },
                refundedMinor: { $sum: '$amountRefundedMinor' },
                feeMinor: { $sum: '$feeMinor' },
              },
            },
          ],
          succeeded: [
            { $match: { status: { $in: [PAYMENT_STATUS.SUCCESS, PAYMENT_STATUS.PARTIALLY_REFUNDED, PAYMENT_STATUS.REFUNDED] } } },
            { $group: { _id: null, count: { $sum: 1 }, amountMinor: { $sum: '$amountMinor' } } },
          ],
          byMethod: [
            { $group: { _id: '$method', count: { $sum: 1 }, amountMinor: { $sum: '$amountMinor' } } },
            { $sort: { amountMinor: -1 } },
          ],
          byCurrency: [
            { $group: { _id: '$currency', count: { $sum: 1 }, amountMinor: { $sum: '$amountMinor' } } },
          ],
          failureReasons: [
            { $match: { status: PAYMENT_STATUS.FAILED, 'failure.code': { $ne: null } } },
            { $group: { _id: '$failure.code', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 5 },
          ],
        },
      },
    ]);
    return result;
  }

  /**
   * Payment volume bucketed by hour or day, for the dashboard time series.
   * `$dateTrunc` (MongoDB 5.0+) buckets server-side so we never ship raw rows
   * to Node just to group them.
   */
  timeSeries(merchantFilter, { from, to, unit = 'hour' }) {
    return this.aggregate([
      { $match: { ...merchantFilter, createdAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: {
            bucket: { $dateTrunc: { date: '$createdAt', unit } },
            status: '$status',
          },
          count: { $sum: 1 },
          amountMinor: { $sum: '$amountMinor' },
        },
      },
      {
        $group: {
          _id: '$_id.bucket',
          total: { $sum: '$count' },
          amountMinor: { $sum: '$amountMinor' },
          statuses: { $push: { status: '$_id.status', count: '$count', amountMinor: '$amountMinor' } },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, bucket: '$_id', total: 1, amountMinor: 1, statuses: 1 } },
    ]);
  }
}

const TERMINAL = [
  PAYMENT_STATUS.SUCCESS, PAYMENT_STATUS.FAILED,
  PAYMENT_STATUS.CANCELLED, PAYMENT_STATUS.REFUNDED,
];

module.exports = new PaymentRepository();
module.exports.PaymentRepository = PaymentRepository;
