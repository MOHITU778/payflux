'use strict';

const config = require('../../config');

/**
 * Fraud rule definitions.
 *
 * Each rule is a small, independently testable unit:
 *   { id, name, severity, weight, evaluate(signals, ctx) → hit | null }
 *
 * A rule returns `null` when it does not fire, or a hit carrying the evidence
 * that made it fire. Storing the evidence is deliberate — an analyst reviewing
 * a block needs to see "14 attempts in 300s", not just "velocity rule fired".
 *
 * Weights are additive and the total is capped at 100. A single CRITICAL rule
 * is enough to cross the block threshold on its own; MEDIUM rules must
 * corroborate each other. Keeping weights in one table is what makes the
 * engine tunable from the score distribution the fraud logs record.
 */

const SEVERITY = Object.freeze({ LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', CRITICAL: 'CRITICAL' });

/** Free/disposable mail domains correlate strongly with card testing. */
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'tempmail.com', '10minutemail.com',
  'throwaway.email', 'yopmail.com', 'trashmail.com', 'sharklasers.com',
]);

/** Sanctioned / high-risk jurisdictions where we do not acquire. */
const RESTRICTED_COUNTRIES = new Set(['KP', 'IR', 'SY', 'CU']);

const rules = [
  {
    id: 'HIGH_AMOUNT',
    name: 'Transaction exceeds high-value threshold',
    severity: SEVERITY.MEDIUM,
    weight: 25,
    evaluate(signals) {
      if (signals.amountMinor <= config.fraud.highAmountMinor) return null;
      return {
        detail: `Amount ${signals.amountMinor} exceeds threshold ${config.fraud.highAmountMinor}`,
        evidence: { amountMinor: signals.amountMinor, threshold: config.fraud.highAmountMinor },
      };
    },
  },

  {
    id: 'MERCHANT_LIMIT_EXCEEDED',
    name: 'Amount above the merchant per-transaction cap',
    severity: SEVERITY.HIGH,
    weight: 40,
    evaluate(signals, ctx) {
      const cap = ctx.merchant?.riskProfile?.maxTransactionMinor;
      if (!cap || signals.amountMinor <= cap) return null;
      return {
        detail: `Amount ${signals.amountMinor} exceeds merchant cap ${cap}`,
        evidence: { amountMinor: signals.amountMinor, cap },
      };
    },
  },

  {
    id: 'VELOCITY_CUSTOMER',
    name: 'Too many attempts from the same customer in a short window',
    severity: SEVERITY.HIGH,
    weight: 30,
    evaluate(signals) {
      const { velocityCount } = signals;
      if (velocityCount == null || velocityCount <= config.fraud.velocityMaxAttempts) return null;
      // Scale with the overshoot: 2x the limit is worse than 1.1x.
      const overshoot = velocityCount / config.fraud.velocityMaxAttempts;
      return {
        detail: `${velocityCount} attempts in ${config.fraud.velocityWindowSeconds}s`,
        weightMultiplier: Math.min(2, overshoot),
        evidence: {
          attempts: velocityCount,
          limit: config.fraud.velocityMaxAttempts,
          windowSeconds: config.fraud.velocityWindowSeconds,
        },
      };
    },
  },

  {
    id: 'VELOCITY_IP',
    name: 'Too many attempts from the same IP address',
    severity: SEVERITY.HIGH,
    weight: 25,
    evaluate(signals) {
      const { ipVelocityCount } = signals;
      if (ipVelocityCount == null || ipVelocityCount <= config.fraud.velocityMaxAttempts) return null;
      return {
        detail: `${ipVelocityCount} attempts from ${signals.ipAddress}`,
        evidence: { attempts: ipVelocityCount, ipAddress: signals.ipAddress },
      };
    },
  },

  {
    id: 'REPEATED_FAILURES',
    name: 'Repeated recent declines for this customer',
    severity: SEVERITY.HIGH,
    weight: 35,
    evaluate(signals) {
      // A burst of declines followed by an attempt is the classic signature of
      // card testing: the attacker is iterating through stolen credentials.
      if ((signals.recentFailureCount ?? 0) < 3) return null;
      return {
        detail: `${signals.recentFailureCount} failed attempts in the recent window`,
        evidence: { failures: signals.recentFailureCount },
      };
    },
  },

  {
    id: 'COUNTRY_MISMATCH',
    name: 'IP geolocation disagrees with the billing country',
    severity: SEVERITY.MEDIUM,
    weight: 20,
    evaluate(signals) {
      const { ipCountry, billingCountry } = signals;
      if (!ipCountry || !billingCountry || ipCountry === billingCountry) return null;
      return {
        detail: `IP country ${ipCountry} differs from billing country ${billingCountry}`,
        evidence: { ipCountry, billingCountry },
      };
    },
  },

  {
    id: 'RESTRICTED_COUNTRY',
    name: 'Origin is a restricted jurisdiction',
    severity: SEVERITY.CRITICAL,
    weight: 100, // sanctions are not a scoring matter - block outright
    evaluate(signals) {
      const country = signals.ipCountry || signals.billingCountry;
      if (!country || !RESTRICTED_COUNTRIES.has(country)) return null;
      return { detail: `Restricted country: ${country}`, evidence: { country } };
    },
  },

  {
    id: 'MERCHANT_BLOCKED_COUNTRY',
    name: 'Country is on the merchant block list',
    severity: SEVERITY.HIGH,
    weight: 60,
    evaluate(signals, ctx) {
      const profile = ctx.merchant?.riskProfile ?? {};
      const country = signals.ipCountry || signals.billingCountry;
      if (!country) return null;
      if (profile.blockedCountries?.includes(country)) {
        return { detail: `${country} is blocked by merchant policy`, evidence: { country } };
      }
      // An allow-list, when present, is exhaustive.
      if (profile.allowedCountries?.length && !profile.allowedCountries.includes(country)) {
        return {
          detail: `${country} is not in the merchant allow-list`,
          evidence: { country, allowed: profile.allowedCountries },
        };
      }
      return null;
    },
  },

  {
    id: 'DISPOSABLE_EMAIL',
    name: 'Customer used a disposable email domain',
    severity: SEVERITY.LOW,
    weight: 15,
    evaluate(signals) {
      const domain = String(signals.customerEmail ?? '').split('@')[1]?.toLowerCase();
      if (!domain || !DISPOSABLE_DOMAINS.has(domain)) return null;
      return { detail: `Disposable email domain: ${domain}`, evidence: { domain } };
    },
  },

  {
    id: 'CARD_TESTING_PATTERN',
    name: 'Many low-value attempts - probable card testing',
    severity: SEVERITY.CRITICAL,
    weight: 50,
    evaluate(signals) {
      // Small amounts are used to validate a stolen card cheaply before the
      // real charge. Low value plus high frequency is the tell.
      const isProbe = signals.amountMinor <= 10000; // <= 100 major units
      if (!isProbe || (signals.velocityCount ?? 0) < 5) return null;
      return {
        detail: `${signals.velocityCount} low-value attempts (${signals.amountMinor} minor units)`,
        evidence: { attempts: signals.velocityCount, amountMinor: signals.amountMinor },
      };
    },
  },

  {
    id: 'AMOUNT_ANOMALY',
    name: 'Amount is far outside this merchant normal range',
    severity: SEVERITY.MEDIUM,
    weight: 20,
    evaluate(signals) {
      const { merchantAverageMinor, amountMinor } = signals;
      // Require a meaningful baseline: a merchant with three payments has no
      // stable average, and firing on noise would just add false positives.
      if (!merchantAverageMinor || (signals.merchantPaymentCount ?? 0) < 20) return null;
      const ratio = amountMinor / merchantAverageMinor;
      if (ratio < 10) return null;
      return {
        detail: `Amount is ${ratio.toFixed(1)}x the merchant average`,
        evidence: { amountMinor, averageMinor: merchantAverageMinor, ratio: Number(ratio.toFixed(2)) },
      };
    },
  },

  {
    id: 'MISSING_DEVICE_FINGERPRINT',
    name: 'No device fingerprint supplied',
    severity: SEVERITY.LOW,
    weight: 10,
    evaluate(signals) {
      if (signals.deviceFingerprint) return null;
      return { detail: 'Request carried no device fingerprint', evidence: null };
    },
  },
];

module.exports = { rules, SEVERITY, DISPOSABLE_DOMAINS, RESTRICTED_COUNTRIES };
