'use strict';

const logger = require('../config/logger');
const metrics = require('../config/metrics');
const { CircuitOpenError } = require('../errors');

/**
 * Circuit breaker.
 *
 * Protects the system from a failing dependency in two directions: it stops us
 * queueing thousands of doomed requests against a downed acquirer (which would
 * exhaust our own connection pool and take *us* down), and it gives the
 * dependency room to recover instead of being hammered while it restarts.
 *
 *   CLOSED    — traffic flows. Consecutive failures are counted.
 *   OPEN      — every call fails fast with CircuitOpenError. No I/O is attempted.
 *   HALF_OPEN — after the cooldown, a limited number of probes are allowed
 *               through. Enough successes close the circuit; one failure
 *               re-opens it and restarts the cooldown.
 *
 * The half-open state is what prevents flapping: without it, the first request
 * after the cooldown either fully reopens the floodgates or is wasted.
 */

const STATE = Object.freeze({ CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' });
const STATE_GAUGE = { [STATE.CLOSED]: 0, [STATE.HALF_OPEN]: 1, [STATE.OPEN]: 2 };

class CircuitBreaker {
  /**
   * @param {string} name
   * @param {object} [options]
   * @param {number} [options.failureThreshold]  Consecutive failures before opening.
   * @param {number} [options.successThreshold]  Consecutive half-open successes before closing.
   * @param {number} [options.timeoutMs]         Cooldown before probing again.
   * @param {number} [options.halfOpenMaxCalls]  Concurrent probes permitted.
   * @param {(err: Error) => boolean} [options.isFailure]  Which errors count against the circuit.
   */
  constructor(name, options = {}) {
    this.name = name;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.successThreshold = options.successThreshold ?? 2;
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.halfOpenMaxCalls = options.halfOpenMaxCalls ?? 1;
    // By default a 4xx-style business rejection is a *valid answer*, not a
    // dependency failure — counting it would open the circuit on bad input.
    this.isFailure = options.isFailure ?? ((err) => !(err.status >= 400 && err.status < 500));

    this.state = STATE.CLOSED;
    this.failures = 0;
    this.successes = 0;
    this.halfOpenCalls = 0;
    this.openedAt = null;
    this.stats = { calls: 0, failures: 0, rejections: 0, successes: 0 };
    this.log = logger.child({ component: 'circuit-breaker', breaker: name });
    metrics.circuitState.set({ service: name }, STATE_GAUGE[this.state]);
  }

  /** Move to a new state, keeping the exported gauge in step. */
  transition(next) {
    if (this.state === next) return;
    this.log.warn('circuit state change', { from: this.state, to: next, failures: this.failures });
    this.state = next;
    metrics.circuitState.set({ service: this.name }, STATE_GAUGE[next]);
    if (next === STATE.OPEN) {
      this.openedAt = Date.now();
      this.halfOpenCalls = 0;
      this.successes = 0;
    }
    if (next === STATE.CLOSED) {
      this.failures = 0;
      this.successes = 0;
      this.openedAt = null;
    }
    if (next === STATE.HALF_OPEN) {
      this.halfOpenCalls = 0;
      this.successes = 0;
    }
  }

  get retryAfterMs() {
    if (this.state !== STATE.OPEN) return 0;
    return Math.max(0, this.timeoutMs - (Date.now() - this.openedAt));
  }

  /**
   * Execute `fn` under the breaker.
   * @throws {CircuitOpenError} when the circuit is open (or half-open and saturated).
   */
  async execute(fn) {
    if (this.state === STATE.OPEN) {
      if (this.retryAfterMs > 0) {
        this.stats.rejections += 1;
        throw new CircuitOpenError(this.name, this.retryAfterMs);
      }
      this.transition(STATE.HALF_OPEN); // cooldown elapsed — allow a probe
    }

    if (this.state === STATE.HALF_OPEN && this.halfOpenCalls >= this.halfOpenMaxCalls) {
      this.stats.rejections += 1;
      throw new CircuitOpenError(this.name, this.timeoutMs);
    }

    // `halfOpenCalls` counts probes *in flight*, so it must be released when
    // the probe settles — not left incremented. Leaving it set would pin the
    // breaker half-open forever whenever successThreshold > halfOpenMaxCalls.
    const isProbe = this.state === STATE.HALF_OPEN;
    if (isProbe) this.halfOpenCalls += 1;
    this.stats.calls += 1;

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (err) {
      if (this.isFailure(err)) this.onFailure(err);
      else this.onSuccess(); // dependency answered correctly; the input was bad
      throw err;
    } finally {
      if (isProbe) this.halfOpenCalls = Math.max(0, this.halfOpenCalls - 1);
    }
  }

  onSuccess() {
    this.stats.successes += 1;
    if (this.state === STATE.HALF_OPEN) {
      this.successes += 1;
      if (this.successes >= this.successThreshold) this.transition(STATE.CLOSED);
      return;
    }
    this.failures = 0;
  }

  onFailure(err) {
    this.stats.failures += 1;
    if (this.state === STATE.HALF_OPEN) {
      // A probe failed — the dependency is still sick. Restart the cooldown.
      this.transition(STATE.OPEN);
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) {
      this.log.error('circuit opened', { failures: this.failures, lastError: err.message });
      this.transition(STATE.OPEN);
    }
  }

  /** Snapshot for the /health endpoint. */
  snapshot() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      retryAfterMs: this.retryAfterMs,
      stats: { ...this.stats },
    };
  }
}

/** Registry so /health can report every breaker without a global import graph. */
const registry = new Map();

function getBreaker(name, options) {
  if (!registry.has(name)) registry.set(name, new CircuitBreaker(name, options));
  return registry.get(name);
}

const snapshotAll = () => [...registry.values()].map((breaker) => breaker.snapshot());

module.exports = { CircuitBreaker, getBreaker, snapshotAll, STATE, registry };
