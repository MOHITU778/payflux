'use strict';

const config = require('../../config');
const logger = require('../../config/logger');
const metrics = require('../../config/metrics');
const cache = require('../cache.service');
const { fraudRepository, paymentRepository } = require('../../repositories');
const { FRAUD_DECISION, PAYMENT_STATUS } = require('../../constants');
const ids = require('../../utils/ids');
const { rules: defaultRules } = require('./rules');

/**
 * Rule-based fraud detection engine.
 *
 * ── Design ─────────────────────────────────────────────────────────────────
 * Signals are gathered once, then every rule is evaluated against that
 * snapshot. Rules are pure functions of the snapshot, which means they can be
 * unit-tested without a database and replayed offline against historical
 * traffic to estimate the impact of a weight change before shipping it.
 *
 * ── Scoring ────────────────────────────────────────────────────────────────
 * Additive weights, capped at 100, mapped to a decision by two thresholds:
 *
 *   score ≥ 80  → BLOCK   the payment is rejected outright
 *   score ≥ 50  → REVIEW  the payment proceeds but is flagged for an analyst
 *   otherwise   → ALLOW
 *
 * High-risk merchants get a stricter block threshold, because the cost of a
 * false negative scales with the merchant's chargeback exposure.
 *
 * ── Latency budget ─────────────────────────────────────────────────────────
 * Scoring sits on the payment path, so signal gathering is parallelised and
 * velocity counters are read from Redis rather than aggregated from Mongo.
 * If any signal lookup fails the engine degrades to scoring on what it has
 * rather than failing the payment — a risk engine that takes down checkout is
 * worse than one that occasionally scores with partial data.
 */
class FraudService {
  constructor({ rules = defaultRules, repository = fraudRepository, cacheService = cache } = {}) {
    this.rules = rules;
    this.repository = repository;
    this.cache = cacheService;
    this.log = logger.child({ component: 'fraud-engine' });
  }

  /**
   * Score a payment attempt.
   *
   * @param {object} params
   * @param {object} params.merchant   Merchant document.
   * @param {object} params.attempt    { amountMinor, currency, customer, context }
   * @returns {Promise<{decision: string, riskScore: number, triggeredRules: object[], fraudLogId: string}>}
   */
  async evaluate({ merchant, attempt }) {
    const startedAt = Date.now();
    const signals = await this.gatherSignals({ merchant, attempt });

    const hits = [];
    for (const rule of this.rules) {
      try {
        const hit = rule.evaluate(signals, { merchant });
        if (!hit) continue;
        // A rule may scale its own weight with the severity of what it saw.
        const weight = Math.round(rule.weight * (hit.weightMultiplier ?? 1));
        hits.push({
          ruleId: rule.id,
          ruleName: rule.name,
          severity: rule.severity,
          weight,
          detail: hit.detail ?? null,
          evidence: hit.evidence ?? null,
        });
      } catch (err) {
        // One broken rule must not fail the whole evaluation — the remaining
        // rules still carry signal.
        this.log.error('fraud rule threw', { ruleId: rule.id, error: err.message });
      }
    }

    const riskScore = Math.min(100, hits.reduce((total, hit) => total + hit.weight, 0));
    const decision = this.decide(riskScore, merchant);
    const evaluationMs = Date.now() - startedAt;

    const fraudLogId = ids.fraudLogId();
    // Persist asynchronously: the verdict is already decided, and the payment
    // path should not wait on an audit write.
    this.persist({ fraudLogId, merchant, attempt, signals, hits, riskScore, decision, evaluationMs })
      .catch((err) => this.log.error('failed to persist fraud log', { error: err.message }));

    metrics.fraudDecisions.inc({ decision });
    if (decision !== FRAUD_DECISION.ALLOW) {
      this.log.warn('elevated risk decision', {
        decision, riskScore, rules: hits.map((h) => h.ruleId), evaluationMs,
      });
    }

    return {
      fraudLogId,
      decision,
      riskScore,
      triggeredRules: hits,
      evaluationMs,
    };
  }

  /**
   * Map a score to a verdict. HIGH-tier merchants block 15 points earlier;
   * LOW-tier merchants get 10 points of extra headroom.
   */
  decide(riskScore, merchant) {
    const tier = merchant?.riskProfile?.tier ?? 'MEDIUM';
    const adjustment = { HIGH: -15, MEDIUM: 0, LOW: 10 }[tier] ?? 0;
    const blockAt = config.fraud.blockThreshold + adjustment;
    const reviewAt = config.fraud.reviewThreshold + adjustment;

    if (riskScore >= blockAt) return FRAUD_DECISION.BLOCK;
    if (riskScore >= reviewAt) return FRAUD_DECISION.REVIEW;
    return FRAUD_DECISION.ALLOW;
  }

  /**
   * Collect every signal the rules need, in parallel.
   *
   * Velocity counters live in Redis as fixed windows — an `INCR` plus a TTL is
   * O(1), whereas counting payments in Mongo on every checkout would put a
   * range scan on the critical path.
   */
  async gatherSignals({ merchant, attempt }) {
    const { amountMinor, currency, customer = {}, context = {} } = attempt;
    const customerKey = customer.email ?? customer.customerId ?? 'anonymous';
    const windowSeconds = config.fraud.velocityWindowSeconds;

    const [velocityCount, ipVelocityCount, recentFailureCount, merchantProfile] = await Promise.all([
      this.cache
        .incrementWindow(`velocity:cust:${merchant.merchantId}`, customerKey, windowSeconds)
        .catch(() => null),
      context.ipAddress
        ? this.cache
          .incrementWindow(`velocity:ip:${merchant.merchantId}`, context.ipAddress, windowSeconds)
          .catch(() => null)
        : Promise.resolve(null),
      this.recentFailures(merchant._id, customer.email),
      this.merchantBaseline(merchant),
    ]);

    return {
      amountMinor,
      currency,
      customerEmail: customer.email ?? null,
      customerId: customer.customerId ?? null,
      ipAddress: context.ipAddress ?? null,
      ipCountry: context.country ?? null,
      billingCountry: customer.country ?? context.country ?? null,
      deviceFingerprint: context.deviceFingerprint ?? null,
      velocityCount,
      ipVelocityCount,
      recentFailureCount,
      merchantAverageMinor: merchantProfile.averageMinor,
      merchantPaymentCount: merchantProfile.count,
    };
  }

  /** Declines for this customer in the recent window. */
  async recentFailures(merchantObjectId, email) {
    if (!email) return 0;
    try {
      return await paymentRepository.countRecent(
        { merchant: merchantObjectId, 'customer.email': email, status: PAYMENT_STATUS.FAILED },
        config.fraud.velocityWindowSeconds * 1000,
      );
    } catch (err) {
      this.log.warn('failure-count signal unavailable', { error: err.message });
      return 0;
    }
  }

  /**
   * The merchant's typical transaction size, cached for 10 minutes.
   * This baseline changes slowly, so recomputing it per payment would be pure
   * waste on the hot path.
   */
  async merchantBaseline(merchant) {
    try {
      return await this.cache.wrap(
        'fraud:baseline',
        String(merchant._id),
        async () => {
          const [row] = await paymentRepository.aggregate([
            {
              $match: {
                merchant: merchant._id,
                status: { $in: [PAYMENT_STATUS.SUCCESS, PAYMENT_STATUS.PARTIALLY_REFUNDED] },
              },
            },
            { $group: { _id: null, averageMinor: { $avg: '$amountMinor' }, count: { $sum: 1 } } },
          ]);
          return { averageMinor: row?.averageMinor ?? null, count: row?.count ?? 0 };
        },
        600,
      );
    } catch (err) {
      this.log.warn('baseline signal unavailable', { error: err.message });
      return { averageMinor: null, count: 0 };
    }
  }

  persist({ fraudLogId, merchant, attempt, signals, hits, riskScore, decision, evaluationMs }) {
    return this.repository.create({
      fraudLogId,
      merchant: merchant._id,
      paymentId: attempt.paymentId ?? null,
      riskScore,
      decision,
      triggeredRules: hits,
      signals: {
        amountMinor: signals.amountMinor,
        currency: signals.currency,
        ipAddress: signals.ipAddress,
        ipCountry: signals.ipCountry,
        billingCountry: signals.billingCountry,
        customerEmail: signals.customerEmail,
        deviceFingerprint: signals.deviceFingerprint,
        velocityCount: signals.velocityCount,
        recentFailureCount: signals.recentFailureCount,
      },
      evaluationMs,
    });
  }

  /** Link a completed evaluation to the payment it produced. */
  attachPayment(fraudLogId, paymentId) {
    return this.repository.updateOne({ fraudLogId }, { $set: { paymentId } });
  }

  /** An analyst overturning an automated verdict. */
  async review(fraudLogId, { userId, decision, notes }) {
    return this.repository.updateOne(
      { fraudLogId },
      { $set: { reviewedBy: userId, reviewDecision: decision, reviewNotes: notes } },
    );
  }

  listAlerts(merchantFilter, query) {
    return this.repository.listAlerts(merchantFilter, query);
  }

  /** Everything the fraud dashboard tile needs, in parallel. */
  async analytics(merchantFilter, range) {
    const [breakdown, topRules, distribution] = await Promise.all([
      this.repository.decisionBreakdown(merchantFilter, range),
      this.repository.topRules(merchantFilter, range),
      this.repository.scoreDistribution(merchantFilter, range),
    ]);
    return { breakdown, topRules, distribution };
  }
}

module.exports = new FraudService();
module.exports.FraudService = FraudService;
