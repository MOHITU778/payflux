'use strict';

const http = require('node:http');
const config = require('./config');
const logger = require('./config/logger');
const database = require('./config/database');
const redis = require('./config/redis');
const queues = require('./queues');
const createApp = require('./app');
const schedulers = require('./jobs');

/**
 * API process entry point.
 *
 * Boot order matters: dependencies are verified *before* the port is opened.
 * Listening first would mean the load balancer starts routing traffic to a
 * replica that cannot reach Mongo, and every one of those requests becomes a
 * 500 that a readiness probe could have prevented.
 */

let server;
let shuttingDown = false;

async function start() {
  logger.info('starting payflux api', { env: config.env, pid: process.pid, node: process.version });

  await database.connect();
  await redis.connect();

  const app = createApp();
  server = http.createServer(app);

  // Slightly above a typical ALB's 60s idle timeout, so the load balancer
  // closes idle connections first. If Node closed them first there would be a
  // race where a connection is reused just as it is being torn down, surfacing
  // as sporadic 502s.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 30_000;

  await new Promise((resolve) => server.listen(config.port, resolve));
  logger.info('http server listening', {
    port: config.port,
    docs: `http://localhost:${config.port}${config.apiPrefix}/docs`,
  });

  if (config.settlement.enableSchedulers) schedulers.start();

  return server;
}

/**
 * Graceful shutdown.
 *
 * On SIGTERM the orchestrator has already decided this pod is going away. The
 * sequence protects in-flight money:
 *
 *   1. Stop accepting new connections, but let in-flight requests finish. A
 *      payment killed mid-authorisation is exactly the ambiguity the whole
 *      reconciliation machinery exists to avoid — so don't create one.
 *   2. Stop the schedulers so no new work is started.
 *   3. Close the queues, flushing anything buffered.
 *   4. Close the datastore connections last: an in-flight request may still
 *      need them right up until step 1 completes.
 *
 * A hard timeout bounds the whole thing — a stuck request must not block the
 * deployment forever.
 */
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('graceful shutdown initiated', { signal, timeoutMs: config.shutdownTimeoutMs });

  const forceExit = setTimeout(() => {
    logger.error('graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref(); // do not keep the loop alive just for the timer

  try {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      logger.info('http server closed to new connections');
    }
    schedulers.stop();
    await queues.closeAll();
    await Promise.allSettled([database.disconnect(), redis.disconnect()]);

    clearTimeout(forceExit);
    logger.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    logger.error('error during shutdown', { error: err.message });
    process.exit(1);
  }
}

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => shutdown(signal));
}

/**
 * An unhandled rejection means a promise failed with nobody watching — the
 * process state is unknown from here on. Log it and shut down cleanly rather
 * than continuing to serve payments from a process in an undefined state.
 */
process.on('unhandledRejection', (reason) => {
  logger.error('unhandled promise rejection', {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
  shutdown('unhandledRejection');
});

process.on('uncaughtException', (err) => {
  logger.error('uncaught exception', { error: err.message, stack: err.stack });
  shutdown('uncaughtException');
});

if (require.main === module) {
  start().catch((err) => {
    logger.error('failed to start', { error: err.message, stack: err.stack });
    process.exit(1);
  });
}

module.exports = { start, shutdown, createApp };
