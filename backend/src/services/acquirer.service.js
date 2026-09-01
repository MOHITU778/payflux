'use strict';

const crypto = require('node:crypto');
const config = require('../config');
const logger = require('../config/logger');
const { getBreaker } = require('./circuitBreaker.service');
const { UpstreamServiceError } = require('../errors');
const { sleep } = require('../utils/backoff');

/**
 * Acquirer adapter.
 *
 * In production this would speak ISO 8583 or a PSP's REST API. Here it is a
 * deterministic simulator, but the *boundary* is real and is what the rest of
 * the system is built against: every call is wrapped in a circuit breaker,
 * carries a timeout, and returns either a structured decline or a retryable
 * upstream failure. Swapping the simulator for a real client means replacing
 * the body of `send`, and nothing else.
 *
 * The distinction the rest of the system depends on:
 *   • a **decline** is a valid business answer (insufficient funds) — final,
 *     not retryable, and must not open the circuit;
 *   • an **upstream failure** (timeout, 5xx) is retryable and does count
 *     against the circuit.
 * Conflating the two is how a gateway ends up retrying a hard decline
 * forever, or refusing service because customers had no money.
 */

/** Declines a real acquirer returns, with rough real-world frequencies. */
const DECLINE_CODES = [
  { code: 'INSUFFICIENT_FUNDS', message: 'Insufficient funds', weight: 40 },
  { code: 'CARD_EXPIRED', message: 'Card has expired', weight: 15 },
  { code: 'DO_NOT_HONOR', message: 'Issuer declined the transaction', weight: 20 },
  { code: 'INVALID_CVV', message: 'Card security code is incorrect', weight: 10 },
  { code: 'LIMIT_EXCEEDED', message: 'Transaction exceeds the card limit', weight: 10 },
  { code: 'SUSPECTED_FRAUD', message: 'Issuer flagged the transaction', weight: 5 },
];

class AcquirerService {
  constructor(options = {}) {
    this.name = options.name ?? 'simulated-acquirer';
    this.latencyMs = options.latencyMs ?? config.acquirer.latencyMs;
    this.failureRate = options.failureRate ?? config.acquirer.failureRate;
    this.log = logger.child({ component: 'acquirer', acquirer: this.name });
    this.breaker = getBreaker(this.name, {
      failureThreshold: config.breaker.failureThreshold,
      successThreshold: config.breaker.successThreshold,
      timeoutMs: config.breaker.timeoutMs,
      // A decline carries status 402 — a valid answer, so it must not count
      // against the circuit. Only transport/5xx failures do.
      isFailure: (err) => err.code === 'UPSTREAM_UNAVAILABLE' || err.code === 'ACQUIRER_TIMEOUT',
    });
  }

  /**
   * Authorise and capture in one step.
   *
   * @returns {Promise<{approved: boolean, referenceId: string, authCode?: string,
   *                    declineCode?: string, declineMessage?: string, latencyMs: number}>}
   * @throws {UpstreamServiceError} on a retryable transport failure.
   */
  async authorize({ paymentId, amountMinor, currency, method, customer }) {
    return this.breaker.execute(async () => {
      const started = Date.now();
      await this.simulateNetwork();

      // Deterministic per payment: a retry of the same payment gets the same
      // answer, which is what makes the whole flow reproducible in tests.
      const roll = this.deterministicRoll(paymentId);

      if (roll < this.failureRate) {
        this.log.warn('acquirer transport failure', { paymentId });
        throw new UpstreamServiceError(this.name);
      }

      // ~8% of the remaining traffic declines, mirroring typical card rates.
      const declineBoundary = this.failureRate + 0.08;
      if (roll < declineBoundary) {
        const decline = this.pickDecline(paymentId);
        this.log.info('acquirer declined', { paymentId, declineCode: decline.code });
        return {
          approved: false,
          referenceId: this.reference(paymentId),
          declineCode: decline.code,
          declineMessage: decline.message,
          latencyMs: Date.now() - started,
        };
      }

      this.log.info('acquirer approved', { paymentId, amountMinor, currency, method });
      return {
        approved: true,
        referenceId: this.reference(paymentId),
        authCode: crypto.createHash('sha1').update(`auth:${paymentId}`).digest('hex').slice(0, 6).toUpperCase(),
        network: customer?.network ?? 'VISA',
        latencyMs: Date.now() - started,
      };
    });
  }

  /**
   * Return funds to the cardholder.
   * Refunds at a real acquirer are asynchronous — they are accepted now and
   * confirmed by webhook later — so this returns an ACCEPTED acknowledgement
   * rather than a final state.
   */
  async refund({ refundId, paymentId, amountMinor, currency }) {
    return this.breaker.execute(async () => {
      await this.simulateNetwork();
      const roll = this.deterministicRoll(refundId);
      if (roll < this.failureRate) throw new UpstreamServiceError(this.name);

      this.log.info('acquirer accepted refund', { refundId, paymentId, amountMinor, currency });
      return { accepted: true, referenceId: this.reference(refundId), status: 'ACCEPTED' };
    });
  }

  /** Void an authorisation that has not yet been captured. */
  async cancel({ paymentId }) {
    return this.breaker.execute(async () => {
      await this.simulateNetwork();
      this.log.info('acquirer voided authorisation', { paymentId });
      return { cancelled: true, referenceId: this.reference(paymentId) };
    });
  }

  /** Bank payout instruction for a settlement batch. */
  async payout({ settlementId, netAmountMinor, currency }) {
    return this.breaker.execute(async () => {
      await this.simulateNetwork();
      const roll = this.deterministicRoll(settlementId);
      if (roll < this.failureRate) throw new UpstreamServiceError(this.name);

      this.log.info('payout instructed', { settlementId, netAmountMinor, currency });
      return { accepted: true, reference: `payout_${this.reference(settlementId)}` };
    });
  }

  // ── Simulation internals ──────────────────────────────────────────────

  /** Jittered latency so timing-dependent code paths get exercised. */
  simulateNetwork() {
    return sleep(this.latencyMs + Math.floor(Math.random() * this.latencyMs));
  }

  /**
   * Hash the id into a stable [0,1) value.
   * Deterministic rather than random so an integration test can assert the
   * outcome for a fixed id, and so a retry is consistent with the first call.
   */
  deterministicRoll(seed) {
    const hash = crypto.createHash('sha256').update(String(seed)).digest();
    return hash.readUInt32BE(0) / 0xffffffff;
  }

  pickDecline(seed) {
    const total = DECLINE_CODES.reduce((sum, entry) => sum + entry.weight, 0);
    let point = this.deterministicRoll(`decline:${seed}`) * total;
    for (const entry of DECLINE_CODES) {
      point -= entry.weight;
      if (point <= 0) return entry;
    }
    return DECLINE_CODES[0];
  }

  reference(seed) {
    return `acq_${crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 20)}`;
  }

  health() {
    return this.breaker.snapshot();
  }
}

module.exports = new AcquirerService();
module.exports.AcquirerService = AcquirerService;
module.exports.DECLINE_CODES = DECLINE_CODES;
