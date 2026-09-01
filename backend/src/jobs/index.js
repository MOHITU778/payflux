'use strict';

const config = require('../config');
const logger = require('../config/logger');
const settlementService = require('../services/settlement.service');
const reconciliationService = require('../services/reconciliation.service');
const webhookService = require('../services/webhook.service');
const lockService = require('../services/lock.service');
const { webhookRepository, paymentRepository, refundRepository } = require('../repositories');
const { PAYMENT_STATUS, REFUND_STATUS } = require('../constants');
const producers = require('../queues/producers');

/**
 * Scheduled jobs.
 *
 * ── Why locks around a cron ────────────────────────────────────────────────
 * Every API replica runs this scheduler. Without coordination, a three-replica
 * deployment would run the settlement sweep three times at 06:00 — and while
 * the batch key makes that harmless, it is three times the load for no benefit.
 * Each tick therefore takes a short distributed lock and only the winner
 * executes. This is a poor-man's leader election, which is the right amount of
 * machinery for periodic maintenance work.
 *
 * ── Why intervals, not a cron library ──────────────────────────────────────
 * The schedules here are simple fixed periods. `setInterval` plus a lock has no
 * dependency, no parser and no timezone semantics to get wrong. A genuinely
 * calendar-based schedule ("03:00 on the last business day") would warrant a
 * real cron parser.
 */

const log = logger.child({ component: 'scheduler' });
const timers = [];

/**
 * Run `task` only if this replica wins the lock for the tick.
 * @param {string} name       Lock resource name.
 * @param {number} ttlMs      Lock lease — must exceed the task's worst-case runtime.
 * @param {Function} task
 */
async function runExclusively(name, ttlMs, task) {
  // No retries: if another replica holds it, this tick is already being handled.
  const lock = await lockService.tryAcquire(`scheduler:${name}`, ttlMs);
  if (!lock) {
    log.debug('another replica owns this tick', { job: name });
    return null;
  }
  try {
    const startedAt = Date.now();
    const result = await task();
    log.info('scheduled job complete', { job: name, durationMs: Date.now() - startedAt });
    return result;
  } catch (err) {
    log.error('scheduled job failed', { job: name, error: err.message, stack: err.stack });
    return null;
  } finally {
    await lockService.release(lock).catch(() => {});
  }
}

/** Register an interval that runs exclusively across replicas. */
function schedule(name, intervalMs, task, { lockTtlMs } = {}) {
  const timer = setInterval(
    () => { runExclusively(name, lockTtlMs ?? Math.floor(intervalMs * 0.9), task); },
    intervalMs,
  );
  // Never keep the process alive purely for a scheduler.
  timer.unref();
  timers.push({ name, timer, intervalMs });
  log.info('job scheduled', { job: name, intervalMinutes: Math.round(intervalMs / 60000) });
}

const HOUR = 3_600_000;
const MINUTE = 60_000;

function start() {
  // ── Settlement sweep ─────────────────────────────────────────────────
  // Builds payout batches for every auto-settle merchant.
  schedule('settlement-sweep', 6 * HOUR, () => settlementService.runScheduledSweep(), {
    lockTtlMs: 10 * MINUTE,
  });

  // ── Webhook retry sweeper ────────────────────────────────────────────
  // A safety net beneath BullMQ's delayed jobs: if Redis lost a delayed job
  // (eviction, restart), the delivery row still says a retry is due, and this
  // re-enqueues it. Durable state in Mongo is the source of truth; the queue is
  // just the scheduler.
  schedule('webhook-retry-sweep', MINUTE, async () => {
    const due = await webhookRepository.findDueForRetry(200);
    if (!due.length) return { requeued: 0 };
    await Promise.allSettled(
      due.map((delivery) =>
        producers.dispatchWebhook(delivery.deliveryId, { attempt: delivery.attemptCount + 1 })),
    );
    log.info('re-enqueued due webhook deliveries', { count: due.length });
    return { requeued: due.length };
  });

  // ── Stuck-payment reconciliation ─────────────────────────────────────
  // Payments left PROCESSING because the acquirer was unreachable. Each is
  // re-driven so it cannot sit in limbo indefinitely.
  schedule('payment-reconcile', 5 * MINUTE, async () => {
    const stale = await paymentRepository.find(
      {
        status: PAYMENT_STATUS.PROCESSING,
        updatedAt: { $lte: new Date(Date.now() - 2 * MINUTE) },
      },
      { limit: 100, sort: { updatedAt: 1 } },
    );
    if (!stale.length) return { reconciled: 0 };

    const paymentService = require('../services/payment.service');
    const merchantRepository = require('../repositories/merchant.repository');

    let resolved = 0;
    for (const payment of stale) {
      const merchant = await merchantRepository.findById(payment.merchant);
      const updated = await paymentService.reconcileWithAcquirer(payment, merchant).catch(() => null);
      if (updated && updated.status !== PAYMENT_STATUS.PROCESSING) resolved += 1;
    }
    log.info('stuck payments reconciled', { examined: stale.length, resolved });
    return { examined: stale.length, resolved };
  }, { lockTtlMs: 4 * MINUTE });

  // ── Refund retry ─────────────────────────────────────────────────────
  // Refunds that fell back to PENDING after a retryable acquirer failure.
  schedule('refund-retry', 5 * MINUTE, async () => {
    const pending = await refundRepository.find(
      {
        status: REFUND_STATUS.PENDING,
        createdAt: { $lte: new Date(Date.now() - 2 * MINUTE) },
      },
      { limit: 50, sort: { createdAt: 1 } },
    );
    if (!pending.length) return { retried: 0 };

    const refundService = require('../services/refund.service');
    let succeeded = 0;
    for (const refund of pending) {
      const result = await refundService.process(refund.refundId).catch(() => null);
      if (result?.status === REFUND_STATUS.SUCCESS) succeeded += 1;
    }
    log.info('pending refunds retried', { examined: pending.length, succeeded });
    return { examined: pending.length, succeeded };
  }, { lockTtlMs: 4 * MINUTE });

  // ── Ledger reconciliation ────────────────────────────────────────────
  // Recomputes the books from the entry stream and reports any drift.
  schedule('ledger-reconciliation', 12 * HOUR, () =>
    reconciliationService.run({ triggeredBy: 'scheduler' }), { lockTtlMs: 15 * MINUTE });

  // ── Endpoint health report ───────────────────────────────────────────
  schedule('webhook-health-report', HOUR, async () => {
    const stats = await webhookService.stats({}, {
      from: new Date(Date.now() - HOUR), to: new Date(),
    });
    log.info('webhook delivery health', { stats });
    return stats;
  });

  log.info('schedulers started', { jobs: timers.map((entry) => entry.name) });
  return timers;
}

function stop() {
  for (const { timer, name } of timers) {
    clearInterval(timer);
    log.debug('scheduler stopped', { job: name });
  }
  timers.length = 0;
}

module.exports = { start, stop, schedule, runExclusively, timers, config };
