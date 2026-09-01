'use strict';

const { Queue, QueueEvents } = require('bullmq');
const redis = require('../config/redis');
const logger = require('../config/logger');
const metrics = require('../config/metrics');
const { QUEUE } = require('../constants');

/**
 * Queue topology.
 *
 * ── Why queues at all ──────────────────────────────────────────────────────
 * Only two things must happen inside the payment request: take the money and
 * record it. Ledger posting, webhook fan-out, invoices, notifications and
 * settlement are all *consequences* — doing them inline would add hundreds of
 * milliseconds to checkout and couple the customer's success to the health of
 * an email provider. They are published as jobs instead.
 *
 * ── Queues ─────────────────────────────────────────────────────────────────
 *   payment-events    fan-out hub; consumes a domain event and dispatches work
 *   ledger            double-entry posting (money — highest retry budget)
 *   settlement        batch construction and payout instruction
 *   webhook-dispatch  outbound HTTP delivery with its own retry ladder
 *   notification      email/SMS (lossy is acceptable)
 *   invoice           PDF/document generation
 *   dead-letter       terminal failures, retained for inspection and replay
 *
 * ── Delivery semantics ─────────────────────────────────────────────────────
 * BullMQ is at-least-once. A worker can be killed after doing its work but
 * before acking, so the job runs again. Every consumer is therefore idempotent
 * by construction — the ledger through its deterministic journal key, webhooks
 * through the unique (eventId, endpoint) index, payments through CAS status
 * transitions. "Exactly once" is not something a queue can give you; idempotent
 * consumers are.
 */

/** Per-queue retry policy, tuned to how costly a lost job is. */
const QUEUE_DEFAULTS = {
  [QUEUE.PAYMENT_EVENTS]: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 86400 * 7 },
  },
  [QUEUE.LEDGER]: {
    // Money. Retry hard and keep failures for a week — a ledger job that never
    // lands is a book that does not balance.
    attempts: 10,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: { age: 86400, count: 5000 },
    removeOnFail: false, // never auto-remove a failed financial job
  },
  [QUEUE.SETTLEMENT]: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 30000 },
    removeOnComplete: { age: 86400 * 7 },
    removeOnFail: false,
  },
  [QUEUE.WEBHOOK_DISPATCH]: {
    // Retries are driven by our own published ladder (10s → 6h) rather than
    // BullMQ's, so the merchant-visible schedule is explicit and documented.
    attempts: 1,
    removeOnComplete: { age: 3600, count: 5000 },
    removeOnFail: { age: 86400 * 3 },
  },
  [QUEUE.NOTIFICATION]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { age: 1800, count: 500 },
    removeOnFail: { age: 86400 },
  },
  [QUEUE.INVOICE]: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 10000 },
    removeOnComplete: { age: 86400 },
    removeOnFail: { age: 86400 * 3 },
  },
  [QUEUE.DEAD_LETTER]: {
    // Terminal by definition — never retried automatically.
    attempts: 1,
    removeOnComplete: false,
    removeOnFail: false,
  },
};

const queues = new Map();
const queueEvents = new Map();

/**
 * Get (or create) a queue.
 * @param {string} name  One of `QUEUE.*`
 * @returns {import('bullmq').Queue}
 */
function getQueue(name) {
  if (queues.has(name)) return queues.get(name);

  const queue = new Queue(name, {
    connection: redis.getClient('bull'),
    prefix: 'payflux:bull',
    defaultJobOptions: QUEUE_DEFAULTS[name] ?? { attempts: 3, backoff: { type: 'exponential', delay: 2000 } },
  });

  queue.on('error', (err) => logger.error('queue error', { queue: name, error: err.message }));
  queues.set(name, queue);
  return queue;
}

/**
 * Attach a QueueEvents listener for metrics.
 * Only started in the worker process — running it in the API would double-count
 * every job and add a Redis subscriber per replica for no benefit.
 */
function observeQueue(name) {
  if (queueEvents.has(name)) return queueEvents.get(name);
  const events = new QueueEvents(name, { connection: redis.getClient('bull'), prefix: 'payflux:bull' });
  events.on('completed', () => metrics.queueJobsTotal.inc({ queue: name, outcome: 'completed' }));
  events.on('failed', ({ failedReason }) => {
    metrics.queueJobsTotal.inc({ queue: name, outcome: 'failed' });
    logger.warn('job failed', { queue: name, reason: failedReason });
  });
  events.on('stalled', () => metrics.queueJobsTotal.inc({ queue: name, outcome: 'stalled' }));
  queueEvents.set(name, events);
  return events;
}

/**
 * Enqueue a job.
 *
 * `jobId` is the deduplication handle: BullMQ refuses to add a second job with
 * an id that already exists, so a producer retried by its own caller does not
 * create two ledger postings. Pass a deterministic id whenever the work is
 * tied to a specific entity and event.
 */
async function publish(queueName, jobName, data, options = {}) {
  const queue = getQueue(queueName);
  const job = await queue.add(jobName, data, options);
  logger.debug('job enqueued', { queue: queueName, job: jobName, jobId: job.id });
  return job;
}

/**
 * Move a permanently-failed job to the dead-letter queue.
 *
 * The DLQ is not a graveyard — it is an inbox. It preserves the original
 * payload, the queue it came from and the error, so an operator can fix the
 * cause and replay the job rather than reconstructing it by hand from logs.
 */
async function deadLetter({ queue: originQueue, jobName, data, error, attemptsMade }) {
  logger.error('job dead-lettered', { originQueue, jobName, error, attemptsMade });
  metrics.queueJobsTotal.inc({ queue: originQueue, outcome: 'dead_lettered' });
  return publish(
    QUEUE.DEAD_LETTER,
    'dead-letter',
    {
      originQueue,
      jobName,
      payload: data,
      error: String(error),
      attemptsMade,
      deadLetteredAt: new Date().toISOString(),
    },
    { removeOnComplete: false, removeOnFail: false },
  );
}

/** Job counts per queue, for /health and the dashboard's queue tile. */
async function snapshot() {
  const names = Object.values(QUEUE);
  const counts = await Promise.all(
    names.map(async (name) => {
      try {
        const queue = getQueue(name);
        const state = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed');
        for (const [key, value] of Object.entries(state)) {
          metrics.queueDepth.set({ queue: name, state: key }, value);
        }
        return { queue: name, ...state };
      } catch (err) {
        return { queue: name, error: err.message };
      }
    }),
  );
  return counts;
}

/** Drain and close every queue — part of graceful shutdown. */
async function closeAll() {
  await Promise.all([...queues.values()].map((queue) => queue.close().catch(() => {})));
  await Promise.all([...queueEvents.values()].map((events) => events.close().catch(() => {})));
  queues.clear();
  queueEvents.clear();
  logger.info('queues closed');
}

module.exports = {
  QUEUE, getQueue, observeQueue, publish, deadLetter, snapshot, closeAll, QUEUE_DEFAULTS,
};
