'use strict';

const BaseRepository = require('./base.repository');
const { Refund } = require('../models');
const { REFUND_STATUS } = require('../constants');

class RefundRepository extends BaseRepository {
  constructor() { super(Refund); }

  findByRefundId(refundId, opts = {}) {
    return this.findOne({ refundId }, opts);
  }

  findByIdempotencyKey(merchantObjectId, idempotencyKey) {
    return this.findOne({ merchant: merchantObjectId, idempotencyKey });
  }

  listForPayment(paymentObjectId) {
    return this.find({ payment: paymentObjectId }, { sort: { createdAt: -1 } });
  }

  /**
   * Total value already committed against a payment by refunds that are not
   * known-failed. Includes PENDING and PROCESSING deliberately: an in-flight
   * refund still reserves the funds, and ignoring it would let a second request
   * over-refund the payment.
   */
  async committedAmountMinor(paymentObjectId, session) {
    const [row] = await this.aggregate(
      [
        { $match: { payment: paymentObjectId, status: { $ne: REFUND_STATUS.FAILED } } },
        { $group: { _id: null, total: { $sum: '$amountMinor' } } },
      ],
      { session },
    );
    return row?.total ?? 0;
  }

  async refundStats(merchantFilter, { from, to }) {
    const [row] = await this.aggregate([
      { $match: { ...merchantFilter, createdAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          amountMinor: { $sum: '$amountMinor' },
        },
      },
    ]);
    return row;
  }

  byReason(merchantFilter, { from, to }) {
    return this.aggregate([
      { $match: { ...merchantFilter, createdAt: { $gte: from, $lte: to } } },
      { $group: { _id: '$reason', count: { $sum: 1 }, amountMinor: { $sum: '$amountMinor' } } },
      { $sort: { count: -1 } },
    ]);
  }
}

module.exports = new RefundRepository();
module.exports.RefundRepository = RefundRepository;
