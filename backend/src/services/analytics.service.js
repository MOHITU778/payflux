'use strict';

const money = require('../utils/money');
const {
  paymentRepository, refundRepository, settlementRepository, fraudRepository, webhookRepository,
} = require('../repositories');
const { PAYMENT_STATUS } = require('../constants');
const cache = require('./cache.service');
const queues = require('../queues');

/**
 * Dashboard analytics.
 *
 * Every tile on the console is served from here. Two decisions matter:
 *
 *   • **Aggregate in the database.** Grouping happens in `$facet`/`$group`
 *     pipelines, not by streaming rows into Node. A month of payments is
 *     hundreds of thousands of documents; shipping them to the API to call
 *     `.reduce()` would be both slow and memory-unbounded.
 *
 *   • **Cache with a short TTL.** An operations dashboard polling every 15s
 *     does not need per-second freshness. A 30-second cache collapses N
 *     concurrent viewers into one query per window, and `wrap`'s single-flight
 *     stops the refresh from stampeding when the entry expires.
 */
class AnalyticsService {
  constructor(deps = {}) {
    this.payments = deps.paymentRepository ?? paymentRepository;
    this.refunds = deps.refundRepository ?? refundRepository;
    this.settlements = deps.settlementRepository ?? settlementRepository;
    this.fraud = deps.fraudRepository ?? fraudRepository;
    this.webhooks = deps.webhookRepository ?? webhookRepository;
    this.cache = deps.cache ?? cache;
  }

  /** Normalise a `?range=24h|7d|30d` query into a concrete window. */
  static resolveRange(query = {}) {
    const to = query.to ? new Date(query.to) : new Date();
    if (query.from) return { from: new Date(query.from), to };

    const spans = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3, '90d': 90 * 86400e3 };
    const span = spans[query.range] ?? spans['24h'];
    return { from: new Date(to.getTime() - span), to };
  }

  /**
   * The main dashboard payload.
   * All six sub-queries run concurrently — they are independent, and running
   * them in series would make the dashboard's latency their sum.
   */
  async overview({ merchantFilter, query, currency = 'INR' }) {
    const range = AnalyticsService.resolveRange(query);
    const cacheKey = `${JSON.stringify(merchantFilter)}:${range.from.toISOString()}:${range.to.toISOString()}`;

    return this.cache.wrap('analytics:overview', cacheKey, async () => {
      const [stats, refundStats, settlementSummary, fraudBreakdown, webhookStats, queueDepth] =
        await Promise.all([
          this.payments.dashboardStats(merchantFilter, range),
          this.refunds.byReason(merchantFilter, range),
          this.settlements.summary(merchantFilter, range),
          this.fraud.decisionBreakdown(merchantFilter, range),
          this.webhooks.deliveryStats(merchantFilter, range),
          queues.snapshot(),
        ]);

      const totals = stats.totals?.[0] ?? { count: 0, grossMinor: 0, refundedMinor: 0, feeMinor: 0 };
      const succeeded = stats.succeeded?.[0] ?? { count: 0, amountMinor: 0 };

      // Success rate counts every payment that reached a *terminal* state.
      // Including still-pending payments in the denominator would make the
      // rate dip every time traffic spikes, which is misleading.
      const terminal = (stats.byStatus ?? [])
        .filter((row) => row._id !== PAYMENT_STATUS.PENDING && row._id !== PAYMENT_STATUS.PROCESSING)
        .reduce((sum, row) => sum + row.count, 0);
      const successRate = terminal > 0 ? (succeeded.count / terminal) * 100 : 0;

      const failed = (stats.byStatus ?? []).find((row) => row._id === PAYMENT_STATUS.FAILED);
      const netRevenueMinor = totals.grossMinor - totals.refundedMinor;

      return {
        range,
        currency,
        headline: {
          totalPayments: totals.count,
          succeededPayments: succeeded.count,
          failedPayments: failed?.count ?? 0,
          successRate: Number(successRate.toFixed(2)),
          grossVolumeMinor: totals.grossMinor,
          grossVolume: money.toMajorString(totals.grossMinor, currency),
          netRevenueMinor,
          netRevenue: money.toMajorString(netRevenueMinor, currency),
          platformFeeMinor: totals.feeMinor,
          platformFee: money.toMajorString(totals.feeMinor, currency),
          refundedMinor: totals.refundedMinor,
          refunded: money.toMajorString(totals.refundedMinor, currency),
          averageTicketMinor: totals.count ? Math.round(totals.grossMinor / totals.count) : 0,
        },
        byStatus: (stats.byStatus ?? []).map((row) => ({
          status: row._id, count: row.count, amountMinor: row.amountMinor,
          amount: money.toMajorString(row.amountMinor, currency),
        })),
        byMethod: (stats.byMethod ?? []).map((row) => ({
          method: row._id, count: row.count, amountMinor: row.amountMinor,
          amount: money.toMajorString(row.amountMinor, currency),
        })),
        byCurrency: stats.byCurrency ?? [],
        topFailureReasons: stats.failureReasons ?? [],
        refundsByReason: refundStats.map((row) => ({
          reason: row._id, count: row.count, amountMinor: row.amountMinor,
        })),
        settlements: settlementSummary.map((row) => ({
          status: row._id, count: row.count, netMinor: row.netMinor,
          net: money.toMajorString(row.netMinor, currency),
        })),
        fraud: fraudBreakdown.map((row) => ({
          decision: row._id, count: row.count, avgScore: Number((row.avgScore ?? 0).toFixed(1)),
        })),
        webhooks: webhookStats.map((row) => ({
          status: row._id, count: row.count, avgAttempts: Number((row.avgAttempts ?? 0).toFixed(2)),
        })),
        queues: queueDepth,
      };
    }, 30);
  }

  /** Payment volume over time, for the dashboard chart. */
  async timeSeries({ merchantFilter, query, currency = 'INR' }) {
    const range = AnalyticsService.resolveRange(query);
    // Bucket granularity follows the window: hourly buckets over 90 days would
    // return 2,160 points, which no chart can render usefully.
    const spanMs = range.to - range.from;
    const unit = query.unit ?? (spanMs <= 2 * 86400e3 ? 'hour' : 'day');

    const buckets = await this.payments.timeSeries(merchantFilter, { ...range, unit });
    return {
      range,
      unit,
      points: buckets.map((bucket) => {
        const byStatus = Object.fromEntries(
          bucket.statuses.map((entry) => [entry.status, entry.count]),
        );
        const succeeded = (byStatus[PAYMENT_STATUS.SUCCESS] ?? 0)
          + (byStatus[PAYMENT_STATUS.PARTIALLY_REFUNDED] ?? 0)
          + (byStatus[PAYMENT_STATUS.REFUNDED] ?? 0);
        return {
          bucket: bucket.bucket,
          total: bucket.total,
          succeeded,
          failed: byStatus[PAYMENT_STATUS.FAILED] ?? 0,
          amountMinor: bucket.amountMinor,
          amount: money.toMajorString(bucket.amountMinor, currency),
        };
      }),
    };
  }

  /** Fraud tile: verdict mix, most-triggered rules, score histogram. */
  async fraudAnalytics({ merchantFilter, query }) {
    const range = AnalyticsService.resolveRange(query);
    const [breakdown, topRules, distribution] = await Promise.all([
      this.fraud.decisionBreakdown(merchantFilter, range),
      this.fraud.topRules(merchantFilter, range),
      this.fraud.scoreDistribution(merchantFilter, range),
    ]);
    return {
      range,
      breakdown,
      topRules: topRules.map((rule) => ({
        ruleId: rule._id, name: rule.name, hits: rule.hits,
        blocks: rule.blocks, avgScore: Number((rule.avgScore ?? 0).toFixed(1)),
      })),
      distribution: distribution.map((bucket) => ({
        from: bucket._id, count: bucket.count,
      })),
    };
  }
}

module.exports = new AnalyticsService();
module.exports.AnalyticsService = AnalyticsService;
