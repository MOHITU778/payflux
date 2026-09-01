'use strict';

const BaseRepository = require('./base.repository');
const { FraudLog } = require('../models');
const { FRAUD_DECISION } = require('../constants');

class FraudRepository extends BaseRepository {
  constructor() { super(FraudLog); }

  listAlerts(merchantFilter, { decision, minScore, from, to, ...page }) {
    const filter = { ...merchantFilter };
    if (decision) filter.decision = decision;
    else filter.decision = { $in: [FRAUD_DECISION.BLOCK, FRAUD_DECISION.REVIEW] };
    if (minScore) filter.riskScore = { $gte: Number(minScore) };
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = from;
      if (to) filter.createdAt.$lte = to;
    }
    return this.paginate(filter, { ...page, sort: { createdAt: -1 } });
  }

  /** Which rules fire most often — the input to tuning rule weights. */
  topRules(merchantFilter, { from, to, limit = 10 }) {
    return this.aggregate([
      { $match: { ...merchantFilter, createdAt: { $gte: from, $lte: to } } },
      { $unwind: '$triggeredRules' },
      {
        $group: {
          _id: '$triggeredRules.ruleId',
          name: { $first: '$triggeredRules.ruleName' },
          hits: { $sum: 1 },
          avgScore: { $avg: '$riskScore' },
          blocks: { $sum: { $cond: [{ $eq: ['$decision', FRAUD_DECISION.BLOCK] }, 1, 0] } },
        },
      },
      { $sort: { hits: -1 } },
      { $limit: limit },
    ]);
  }

  decisionBreakdown(merchantFilter, { from, to }) {
    return this.aggregate([
      { $match: { ...merchantFilter, createdAt: { $gte: from, $lte: to } } },
      { $group: { _id: '$decision', count: { $sum: 1 }, avgScore: { $avg: '$riskScore' } } },
    ]);
  }

  /** Score histogram in 10-point buckets — used to tune the block threshold. */
  scoreDistribution(merchantFilter, { from, to }) {
    return this.aggregate([
      { $match: { ...merchantFilter, createdAt: { $gte: from, $lte: to } } },
      {
        $bucket: {
          groupBy: '$riskScore',
          boundaries: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 101],
          default: 'other',
          output: { count: { $sum: 1 } },
        },
      },
    ]);
  }
}

module.exports = new FraudRepository();
module.exports.FraudRepository = FraudRepository;
