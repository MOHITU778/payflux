'use strict';

/**
 * Retry timing helpers shared by the webhook dispatcher, the queue retry
 * scheduler and the distributed lock.
 */

/**
 * Exponential backoff with full jitter.
 *
 * Plain exponential backoff synchronises retries: every client that failed at
 * the same moment retries at the same moment, producing a thundering herd that
 * knocks the recovering service straight back over. Full jitter spreads the
 * retries uniformly across the window — see the AWS Architecture Blog,
 * "Exponential Backoff and Jitter".
 *
 * @param {number} attempt       1-based attempt number.
 * @param {object} [opts]
 * @param {number} [opts.baseMs=1000]
 * @param {number} [opts.maxMs=3600000]  Cap (default 1h).
 * @param {boolean}[opts.jitter=true]
 * @returns {number} delay in milliseconds
 */
function exponentialBackoff(attempt, { baseMs = 1000, maxMs = 3_600_000, jitter = true } = {}) {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return jitter ? Math.floor(Math.random() * exponential) : exponential;
}

/**
 * The fixed retry ladder advertised to merchants for webhook delivery:
 * 10s → 60s → 5m → 30m → 2h → 6h, then dead-letter. Publishing a
 * deterministic schedule lets integrators reason about worst-case delivery
 * latency instead of guessing.
 */
const WEBHOOK_RETRY_SCHEDULE_MS = Object.freeze([
  10_000, 60_000, 300_000, 1_800_000, 7_200_000, 21_600_000,
]);

/**
 * Delay before webhook attempt `attempt` (1-based), with ±10% jitter so a
 * merchant recovering from an outage is not hit by every queued delivery at
 * exactly the same instant.
 */
function webhookRetryDelay(attempt) {
  const index = Math.min(attempt - 1, WEBHOOK_RETRY_SCHEDULE_MS.length - 1);
  const base = WEBHOOK_RETRY_SCHEDULE_MS[index];
  const jitter = base * 0.1 * (Math.random() * 2 - 1);
  return Math.max(1000, Math.floor(base + jitter));
}

/** Promise-based sleep. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

module.exports = { exponentialBackoff, webhookRetryDelay, WEBHOOK_RETRY_SCHEDULE_MS, sleep };
