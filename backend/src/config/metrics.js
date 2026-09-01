'use strict';

const client = require('prom-client');

/**
 * Prometheus metric registry.
 *
 * Cardinality discipline: labels are bounded enums (status, method, queue,
 * route template). Never label with a payment id or a raw URL — that turns a
 * handful of series into millions and takes the scrape endpoint down with it.
 */

const registry = new client.Registry();
registry.setDefaultLabels({ service: 'payflux-api' });
client.collectDefaultMetrics({ register: registry, prefix: 'payflux_' });

const httpRequestDuration = new client.Histogram({
  name: 'payflux_http_request_duration_seconds',
  help: 'HTTP request latency by route template and status class',
  labelNames: ['method', 'route', 'status'],
  // Buckets chosen around the payment-API SLO (p99 < 500ms).
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

const httpRequestsTotal = new client.Counter({
  name: 'payflux_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});

const paymentsTotal = new client.Counter({
  name: 'payflux_payments_total',
  help: 'Payments by terminal outcome',
  labelNames: ['status', 'method', 'currency'],
  registers: [registry],
});

const paymentAmountMinor = new client.Counter({
  name: 'payflux_payment_amount_minor_total',
  help: 'Gross processed volume in currency minor units',
  labelNames: ['status', 'currency'],
  registers: [registry],
});

const idempotencyHits = new client.Counter({
  name: 'payflux_idempotency_replays_total',
  help: 'Requests answered from a stored idempotent response instead of re-executing',
  labelNames: ['endpoint'],
  registers: [registry],
});

const lockAcquisitions = new client.Counter({
  name: 'payflux_lock_acquisitions_total',
  help: 'Distributed lock acquisition attempts',
  labelNames: ['resource', 'outcome'],
  registers: [registry],
});

const lockWaitDuration = new client.Histogram({
  name: 'payflux_lock_wait_seconds',
  help: 'Time spent waiting to acquire a distributed lock',
  labelNames: ['resource'],
  buckets: [0.001, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [registry],
});

const queueJobsTotal = new client.Counter({
  name: 'payflux_queue_jobs_total',
  help: 'Queue jobs by terminal outcome',
  labelNames: ['queue', 'outcome'],
  registers: [registry],
});

const queueJobDuration = new client.Histogram({
  name: 'payflux_queue_job_duration_seconds',
  help: 'Queue job processing time',
  labelNames: ['queue', 'name'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 60],
  registers: [registry],
});

const queueDepth = new client.Gauge({
  name: 'payflux_queue_depth',
  help: 'Jobs currently in a queue, by state',
  labelNames: ['queue', 'state'],
  registers: [registry],
});

const webhookDeliveries = new client.Counter({
  name: 'payflux_webhook_deliveries_total',
  help: 'Outbound webhook delivery attempts',
  labelNames: ['outcome', 'event'],
  registers: [registry],
});

const fraudDecisions = new client.Counter({
  name: 'payflux_fraud_decisions_total',
  help: 'Fraud engine verdicts',
  labelNames: ['decision'],
  registers: [registry],
});

const circuitState = new client.Gauge({
  name: 'payflux_circuit_breaker_state',
  help: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
  labelNames: ['service'],
  registers: [registry],
});

const ledgerImbalance = new client.Counter({
  name: 'payflux_ledger_imbalance_total',
  help: 'Ledger postings rejected because debits did not equal credits',
  registers: [registry],
});

module.exports = {
  registry,
  contentType: registry.contentType,
  httpRequestDuration,
  httpRequestsTotal,
  paymentsTotal,
  paymentAmountMinor,
  idempotencyHits,
  lockAcquisitions,
  lockWaitDuration,
  queueJobsTotal,
  queueJobDuration,
  queueDepth,
  webhookDeliveries,
  fraudDecisions,
  circuitState,
  ledgerImbalance,
};
