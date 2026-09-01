'use strict';

const { Worker } = require('bullmq');
const config = require('./../config');
const logger = require('../config/logger');
const database = require('../config/database');
const redis = require('../config/redis');
const metrics = require('../config/metrics');
const queues = require('../queues');
const { QUEUE } = require('../constants');
const requestContext = require('../utils/requestContext');
const { AppError } = require('../errors');

const paymentEventsWorker = require('./paymentEvents.worker');
const ledgerWorker = require('./ledger.worker');
const webhookWorker = require('./webhook.worker');
const settlementWorker = require('./settlement.worker');
const notificationWorker = require('./notification.worker');
const invoiceWorker = require('./invoice.worker');

/**
 * Worker process.
 *
 * Deliberately a **separate process** from the API. Two reasons:
 *
 *   • Isolation — a runaway job (a slow PDF render, a webhook to a black-holing
 *     endpoint) consumes worker CPU, not the CPU serving live payments.
 *   • Independent scaling — webhook dispatch is I/O-bound and wants high
 *     concurrency; ledger posting is write-bound and wants low concurrency to
 *     avoid lock contention. One process could not tune both.
 *
 * Concurrency per queue is set from that reasoning, not from a single global
 * number.
 */

/** name → { processor, concurrency, limiter } */
const WORKER_CONFIG = {
  [QUEUE.PAYMENT_EVENTS]: { processor: paymentEventsWorker.process, concurrency: 10 },
  // Low concurrency: ledger writes contend on the same account documents, and
  // more parallelism here buys throughput at the cost of write conflicts.
  [QUEUE.LEDGER]: { processor: ledgerWorker.process, concurrency: 4 },
  // High concurrency: dispatch is almost entirely waiting on someone else's
  // HTTP server. The rate limiter protects merchants from our own fan-out.
  [QUEUE.WEBHOOK_DISPATCH]: {
    processor: webhookWorker.process,
    concurrency: 25,
    limiter: { max: 200, duration: 1000 },
  },
  [QUEUE.SETTLEMENT]: { processor: settlementWorker.process, concurrency: 2 },
  [QUEUE.NOTIFICATION]: { processor: notificationWorker.process, concurrency: 15 },
  [QUEUE.INVOICE]: { processor: invoiceWorker.process, concurrency: 5 },
};

const workers = [];

/**
 * Wrap a processor so every job runs inside a trace context and reports metrics.
 *
 * Restoring the producer's `correlationId` here is what makes a payment
 * traceable end to end: the log line from a webhook retry six hours later
 * carries the same id as the original HTTP request.
 */
function instrument(queueName, processor) {
  return async (job) => {
    const correlationId = job.data?.correlationId ?? requestContext.newCorrelationId();
    const endTimer = metrics.queueJobDuration.startTimer({ queue: queueName, name: job.name });

    return requestContext.run({ correlationId, requestId: `job_${job.id}` }, async () => {
      try {
        const result = await processor(job);
        endTimer();
        return result;
      } catch (err) {
        endTimer();
        const attemptsLeft = (job.opts.attempts ?? 1) - job.attemptsMade - 1;

        // A non-retryable business error will fail identically on every retry.
        // Burning the retry budget on it just delays the dead-letter and hides
        // the real problem, so send it straight to the DLQ.
        const permanent = err instanceof AppError && !err.retryable;

        if (permanent || attemptsLeft <= 0) {
          await queues.deadLetter({
            queue: queueName,
            jobName: job.name,
            data: job.data,
            error: err.message,
            attemptsMade: job.attemptsMade + 1,
          });
          if (permanent) {
            logger.error('job failed permanently, dead-lettered without retry', {
              queue: queueName, job: job.name, code: err.code, error: err.message,
            });
            return { deadLettered: true, reason: err.code };
          }
        }
        throw err; // let BullMQ apply the backoff and retry
      }
    });
  };
}

async function start() {
  logger.info('starting payflux workers', { pid: process.pid });

  await database.connect();
  await redis.connect();

  for (const [name, settings] of Object.entries(WORKER_CONFIG)) {
    const worker = new Worker(name, instrument(name, settings.processor), {
      connection: redis.getClient('bull'),
      prefix: 'payflux:bull',
      concurrency: settings.concurrency,
      limiter: settings.limiter,
      // A job whose worker died is re-queued after this window. Too short and a
      // slow-but-healthy job gets duplicated; 30s comfortably exceeds our
      // longest normal processing time.
      stalledInterval: 30_000,
      maxStalledCount: 2,
    });

    worker.on('completed', (job) => logger.debug('job completed', { queue: name, job: job.name, id: job.id }));
    worker.on('failed', (job, err) => logger.warn('job failed', {
      queue: name, job: job?.name, id: job?.id, attempt: job?.attemptsMade, error: err.message,
    }));
    worker.on('error', (err) => logger.error('worker error', { queue: name, error: err.message }));

    queues.observeQueue(name);
    workers.push(worker);
    logger.info('worker online', { queue: name, concurrency: settings.concurrency });
  }

  logger.info('all workers online', { count: workers.length });
  return workers;
}

/**
 * Drain and stop.
 *
 * `worker.close()` waits for in-flight jobs to finish before returning, which
 * is what makes a rolling deploy safe: a half-processed ledger posting is not
 * abandoned mid-write, it completes and acks.
 */
async function stop(signal) {
  logger.info('stopping workers', { signal });
  const timer = setTimeout(() => {
    logger.error('worker shutdown timed out — forcing exit');
    process.exit(1);
  }, config.shutdownTimeoutMs);
  timer.unref();

  await Promise.allSettled(workers.map((worker) => worker.close()));
  await queues.closeAll();
  await Promise.allSettled([database.disconnect(), redis.disconnect()]);

  clearTimeout(timer);
  logger.info('workers stopped');
  process.exit(0);
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => stop(signal));
}

if (require.main === module) {
  start().catch((err) => {
    logger.error('failed to start workers', { error: err.message, stack: err.stack });
    process.exit(1);
  });
}

module.exports = { start, stop, WORKER_CONFIG, instrument };
