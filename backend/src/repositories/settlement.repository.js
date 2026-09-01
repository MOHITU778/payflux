'use strict';

const BaseRepository = require('./base.repository');
const { Settlement } = require('../models');
const { SETTLEMENT_STATUS } = require('../constants');

class SettlementRepository extends BaseRepository {
  constructor() { super(Settlement); }

  findBySettlementId(settlementId, opts = {}) {
    return this.findOne({ settlementId }, opts);
  }

  findByBatchKey(batchKey) {
    return this.findOne({ batchKey });
  }

  /** Queue view for the dashboard: everything not yet paid out. */
  pendingQueue(merchantFilter = {}) {
    return this.find(
      { ...merchantFilter, status: { $in: [SETTLEMENT_STATUS.QUEUED, SETTLEMENT_STATUS.PROCESSING] } },
      { sort: { createdAt: 1 }, limit: 100, populate: { path: 'merchant', select: 'name merchantId' } },
    );
  }

  /** CAS transition, mirroring the payment repository's approach. */
  transition(settlementId, from, to, extra = {}) {
    return this.updateOne(
      { settlementId, status: { $in: Array.isArray(from) ? from : [from] } },
      { $set: { status: to, ...extra } },
    );
  }

  async summary(merchantFilter, { from, to }) {
    return this.aggregate([
      { $match: { ...merchantFilter, createdAt: { $gte: from, $lte: to } } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          netMinor: { $sum: '$netAmountMinor' },
          grossMinor: { $sum: '$grossAmountMinor' },
          feeMinor: { $sum: '$feeAmountMinor' },
        },
      },
    ]);
  }
}

module.exports = new SettlementRepository();
module.exports.SettlementRepository = SettlementRepository;
