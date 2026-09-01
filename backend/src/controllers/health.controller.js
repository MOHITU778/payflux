'use strict';

const database = require('../config/database');
const redis = require('../config/redis');
const metrics = require('../config/metrics');
const queues = require('../queues');
const { snapshotAll } = require('../services/circuitBreaker.service');
const asyncHandler = require('../utils/asyncHandler');
const config = require('../config');

const startedAt = Date.now();

/**
 * Health and observability endpoints.
 *
 * Liveness and readiness are separate on purpose, because Kubernetes treats
 * them very differently:
 *
 *   • **liveness** — "is this process wedged?" Answered without touching any
 *     dependency. A failed liveness probe *restarts the pod*, so making it
 *     depend on Mongo would mean a database blip restarts every replica
 *     simultaneously and turns a recoverable incident into an outage.
 *
 *   • **readiness** — "can this replica serve traffic right now?" Checks
 *     dependencies. A failure removes the pod from the load balancer but
 *     leaves it running, so it rejoins on its own once the dependency returns.
 */
module.exports = {
  /** GET /health/live — no dependency checks, by design. */
  live: (_req, res) => res.status(200).json({
    status: 'alive',
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    pid: process.pid,
  }),

  /** GET /health/ready — 503 removes this replica from rotation. */
  ready: asyncHandler(async (_req, res) => {
    const checks = await Promise.allSettled([database.ping(), redis.ping()]);
    const [mongo, cache] = checks.map((result) =>
      (result.status === 'fulfilled'
        ? { ok: true, ...result.value }
        : { ok: false, error: result.reason?.message }));

    const ready = mongo.ok && cache.ok;
    return res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      checks: { mongo, redis: cache },
    });
  }),

  /** GET /health — full diagnostic view for humans and dashboards. */
  detail: asyncHandler(async (_req, res) => {
    const [mongo, cache, queueDepth] = await Promise.all([
      database.ping().catch((err) => ({ ok: false, error: err.message })),
      redis.ping().catch((err) => ({ ok: false, error: err.message })),
      queues.snapshot().catch((err) => ({ error: err.message })),
    ]);

    const memory = process.memoryUsage();
    const healthy = mongo.ok && cache.ok;

    return res.status(healthy ? 200 : 503).json({
      status: healthy ? 'healthy' : 'degraded',
      version: process.env.npm_package_version ?? '1.0.0',
      environment: config.env,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      checks: {
        mongo,
        redis: cache,
        transactionsSupported: database.supportsTransactions(),
      },
      // Circuit state is the clearest single signal of upstream health.
      circuitBreakers: snapshotAll(),
      queues: queueDepth,
      resources: {
        heapUsedMb: Math.round(memory.heapUsed / 1048576),
        heapTotalMb: Math.round(memory.heapTotal / 1048576),
        rssMb: Math.round(memory.rss / 1048576),
      },
    });
  }),

  /**
   * GET /metrics — Prometheus exposition format.
   * Queue depths are refreshed on scrape rather than on a timer, so the gauge
   * is never stale and no background interval is needed.
   */
  metrics: asyncHandler(async (_req, res) => {
    await queues.snapshot().catch(() => {});
    res.set('Content-Type', metrics.registry.contentType);
    return res.end(await metrics.registry.metrics());
  }),
};
