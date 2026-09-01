'use strict';

const { rules } = require('../../src/services/fraud/rules');
const { FraudService } = require('../../src/services/fraud/fraud.service');
const { FRAUD_DECISION } = require('../../src/constants');
const config = require('../../src/config');

/** Rules are pure functions of a signal snapshot, so they need no infrastructure. */
const ruleById = (id) => rules.find((rule) => rule.id === id);
const baseSignals = {
  amountMinor: 100000,
  currency: 'INR',
  customerEmail: 'buyer@example.com',
  ipAddress: '203.0.113.10',
  ipCountry: 'IN',
  billingCountry: 'IN',
  deviceFingerprint: 'fp_abc123',
  velocityCount: 1,
  ipVelocityCount: 1,
  recentFailureCount: 0,
  merchantAverageMinor: 120000,
  merchantPaymentCount: 500,
};
const merchant = {
  _id: 'm1',
  merchantId: 'mrch_test',
  riskProfile: { tier: 'MEDIUM', maxTransactionMinor: 5_000_000, blockedCountries: ['RU'], allowedCountries: [] },
};

describe('fraud rules', () => {
  it('does not fire on a clean, ordinary transaction', () => {
    const hits = rules.map((rule) => rule.evaluate(baseSignals, { merchant })).filter(Boolean);
    expect(hits).toHaveLength(0);
  });

  it('RESTRICTED_COUNTRY fires on a sanctioned jurisdiction', () => {
    const hit = ruleById('RESTRICTED_COUNTRY').evaluate({ ...baseSignals, ipCountry: 'KP' }, { merchant });
    expect(hit).toBeTruthy();
    expect(hit.evidence.country).toBe('KP');
    // Weighted at 100 so it blocks on its own, without corroboration.
    expect(ruleById('RESTRICTED_COUNTRY').weight).toBe(100);
  });

  it('COUNTRY_MISMATCH fires when IP and billing country disagree', () => {
    expect(ruleById('COUNTRY_MISMATCH')
      .evaluate({ ...baseSignals, ipCountry: 'NG', billingCountry: 'IN' }, { merchant })).toBeTruthy();
    expect(ruleById('COUNTRY_MISMATCH')
      .evaluate({ ...baseSignals, ipCountry: null }, { merchant })).toBeNull();
  });

  it('MERCHANT_LIMIT_EXCEEDED respects the per-merchant cap', () => {
    const hit = ruleById('MERCHANT_LIMIT_EXCEEDED')
      .evaluate({ ...baseSignals, amountMinor: 9_000_000 }, { merchant });
    expect(hit.evidence.cap).toBe(5_000_000);
  });

  it('VELOCITY_CUSTOMER scales its weight with the overshoot', () => {
    const rule = ruleById('VELOCITY_CUSTOMER');
    const limit = config.fraud.velocityMaxAttempts;
    expect(rule.evaluate({ ...baseSignals, velocityCount: limit }, { merchant })).toBeNull();
    const mild = rule.evaluate({ ...baseSignals, velocityCount: limit + 1 }, { merchant });
    const severe = rule.evaluate({ ...baseSignals, velocityCount: limit * 3 }, { merchant });
    expect(severe.weightMultiplier).toBeGreaterThan(mild.weightMultiplier);
    expect(severe.weightMultiplier).toBeLessThanOrEqual(2); // capped
  });

  it('CARD_TESTING_PATTERN needs both low value and high frequency', () => {
    const rule = ruleById('CARD_TESTING_PATTERN');
    expect(rule.evaluate({ ...baseSignals, amountMinor: 5000, velocityCount: 2 }, { merchant })).toBeNull();
    expect(rule.evaluate({ ...baseSignals, amountMinor: 500000, velocityCount: 20 }, { merchant })).toBeNull();
    expect(rule.evaluate({ ...baseSignals, amountMinor: 5000, velocityCount: 8 }, { merchant })).toBeTruthy();
  });

  it('AMOUNT_ANOMALY stays quiet without a meaningful baseline', () => {
    const rule = ruleById('AMOUNT_ANOMALY');
    // A merchant with 5 payments has no stable average; firing here would be noise.
    expect(rule.evaluate({
      ...baseSignals, amountMinor: 50_000_000, merchantPaymentCount: 5,
    }, { merchant })).toBeNull();
    expect(rule.evaluate({
      ...baseSignals, amountMinor: 50_000_000, merchantAverageMinor: 100000, merchantPaymentCount: 200,
    }, { merchant })).toBeTruthy();
  });

  it('MERCHANT_BLOCKED_COUNTRY honours both block-list and allow-list', () => {
    const rule = ruleById('MERCHANT_BLOCKED_COUNTRY');
    expect(rule.evaluate({ ...baseSignals, ipCountry: 'RU' }, { merchant })).toBeTruthy();
    const restricted = { ...merchant, riskProfile: { ...merchant.riskProfile, allowedCountries: ['IN'] } };
    expect(rule.evaluate({ ...baseSignals, ipCountry: 'US' }, { merchant: restricted })).toBeTruthy();
    expect(rule.evaluate({ ...baseSignals, ipCountry: 'IN' }, { merchant: restricted })).toBeNull();
  });

  it('DISPOSABLE_EMAIL matches on the domain only', () => {
    const rule = ruleById('DISPOSABLE_EMAIL');
    expect(rule.evaluate({ ...baseSignals, customerEmail: 'x@mailinator.com' }, { merchant })).toBeTruthy();
    expect(rule.evaluate({ ...baseSignals, customerEmail: 'mailinator.com@gmail.com' }, { merchant })).toBeNull();
  });

  it('every rule returns null or a well-formed hit, and never throws', () => {
    const hostile = {
      amountMinor: 0, customerEmail: null, ipAddress: undefined, ipCountry: '',
      velocityCount: null, recentFailureCount: undefined, merchantAverageMinor: 0,
    };
    for (const rule of rules) {
      expect(() => rule.evaluate(hostile, { merchant: {} })).not.toThrow();
      const hit = rule.evaluate(baseSignals, { merchant });
      if (hit) expect(hit).toHaveProperty('detail');
    }
  });
});

describe('fraud scoring and decisions', () => {
  /** A service instance with the datastore-backed signal gathering stubbed out. */
  const buildService = (signals) => {
    const service = new FraudService({
      repository: { create: jest.fn().mockResolvedValue({}), updateOne: jest.fn() },
      cacheService: { incrementWindow: jest.fn(), wrap: jest.fn() },
    });
    service.gatherSignals = jest.fn().mockResolvedValue({ ...baseSignals, ...signals });
    return service;
  };

  it('allows a clean transaction', async () => {
    const result = await buildService({}).evaluate({ merchant, attempt: { amountMinor: 100000 } });
    expect(result.decision).toBe(FRAUD_DECISION.ALLOW);
    expect(result.riskScore).toBe(0);
  });

  it('blocks a sanctioned jurisdiction outright', async () => {
    const result = await buildService({ ipCountry: 'IR', billingCountry: 'IR' })
      .evaluate({ merchant, attempt: { amountMinor: 100000 } });
    expect(result.decision).toBe(FRAUD_DECISION.BLOCK);
    expect(result.riskScore).toBe(100);
    expect(result.triggeredRules.map((r) => r.ruleId)).toContain('RESTRICTED_COUNTRY');
  });

  it('caps the score at 100 however many rules fire', async () => {
    const result = await buildService({
      ipCountry: 'KP', billingCountry: 'IN', amountMinor: 99_000_000,
      velocityCount: 500, ipVelocityCount: 500, recentFailureCount: 50,
      customerEmail: 'a@mailinator.com', deviceFingerprint: null,
    }).evaluate({ merchant, attempt: { amountMinor: 99_000_000 } });
    expect(result.riskScore).toBe(100);
  });

  it('reaches REVIEW before BLOCK as evidence accumulates', async () => {
    // The merchant cap is raised above the high-amount threshold so that
    // MERCHANT_LIMIT_EXCEEDED (weight 40) does not also fire and tip the score
    // straight into BLOCK — this test is about the middle band specifically.
    const generousMerchant = {
      ...merchant,
      riskProfile: { ...merchant.riskProfile, maxTransactionMinor: config.fraud.highAmountMinor * 10 },
    };
    const service = buildService({
      ipCountry: 'NG', billingCountry: 'IN', deviceFingerprint: null,
      amountMinor: config.fraud.highAmountMinor + 1,
    });
    const result = await service.evaluate({
      merchant: generousMerchant, attempt: { amountMinor: config.fraud.highAmountMinor + 1 },
    });
    // 25 (high amount) + 20 (country mismatch) + 20 (amount anomaly vs the
    // merchant's 120000 average) + 10 (no device fingerprint) = 75.
    // Asserting the contributing rules as well as the total, so a future weight
    // change fails with a diagnosis rather than just a number.
    expect(result.triggeredRules.map((r) => r.ruleId).sort()).toEqual([
      'AMOUNT_ANOMALY', 'COUNTRY_MISMATCH', 'HIGH_AMOUNT', 'MISSING_DEVICE_FINGERPRINT',
    ]);
    expect(result.riskScore).toBe(75);
    expect(result.riskScore).toBeGreaterThanOrEqual(config.fraud.reviewThreshold);
    expect(result.riskScore).toBeLessThan(config.fraud.blockThreshold);
    expect(result.decision).toBe(FRAUD_DECISION.REVIEW);
  });

  it('applies a stricter threshold to high-risk merchants', () => {
    const service = buildService({});
    const score = config.fraud.blockThreshold - 10;
    expect(service.decide(score, { riskProfile: { tier: 'HIGH' } })).toBe(FRAUD_DECISION.BLOCK);
    expect(service.decide(score, { riskProfile: { tier: 'MEDIUM' } })).not.toBe(FRAUD_DECISION.BLOCK);
    expect(service.decide(score, { riskProfile: { tier: 'LOW' } })).not.toBe(FRAUD_DECISION.BLOCK);
  });

  it('survives a rule that throws, scoring on the remaining rules', async () => {
    const exploding = [
      { id: 'BOOM', name: 'boom', severity: 'LOW', weight: 10, evaluate() { throw new Error('bug'); } },
      { id: 'OK', name: 'ok', severity: 'HIGH', weight: 40, evaluate: () => ({ detail: 'fired' }) },
    ];
    const service = new FraudService({
      rules: exploding,
      repository: { create: jest.fn().mockResolvedValue({}) },
      cacheService: { incrementWindow: jest.fn(), wrap: jest.fn() },
    });
    service.gatherSignals = jest.fn().mockResolvedValue(baseSignals);
    const result = await service.evaluate({ merchant, attempt: { amountMinor: 1 } });
    expect(result.riskScore).toBe(40);
  });
});
