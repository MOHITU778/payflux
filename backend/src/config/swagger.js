'use strict';

const config = require('./index');
const {
  PAYMENT_STATUS, PAYMENT_METHOD, CURRENCY, REFUND_STATUS, EVENT, FRAUD_DECISION,
} = require('../constants');

/**
 * OpenAPI 3.0 specification.
 *
 * Written as a literal rather than generated from JSDoc annotations so the
 * enums come straight from `constants` — the documented status list cannot
 * drift from the one the state machine enforces.
 */

const errorResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean', example: false },
    error: {
      type: 'object',
      properties: {
        code: { type: 'string', example: 'VALIDATION_ERROR' },
        message: { type: 'string' },
        details: { type: 'object' },
      },
    },
    meta: {
      type: 'object',
      properties: {
        timestamp: { type: 'string', format: 'date-time' },
        correlationId: { type: 'string', example: 'cor_lz8f9k2a4b6c' },
      },
    },
  },
};

const paymentSchema = {
  type: 'object',
  properties: {
    paymentId: { type: 'string', example: 'pay_9fK2mQ7xB4nR1sT8vY3z' },
    status: { type: 'string', enum: Object.values(PAYMENT_STATUS) },
    amountMinor: {
      type: 'integer',
      description: 'Amount in the currency minor unit (paise/cents). 150000 = 1500.00',
      example: 150000,
    },
    amount: { type: 'string', example: '1500.00', description: 'Formatted for display' },
    currency: { type: 'string', enum: Object.values(CURRENCY) },
    feeMinor: { type: 'integer', example: 3000 },
    amountRefundedMinor: { type: 'integer', example: 0 },
    refundableMinor: { type: 'integer', example: 150000 },
    method: { type: 'string', enum: Object.values(PAYMENT_METHOD) },
    risk: {
      type: 'object',
      properties: {
        score: { type: 'integer', minimum: 0, maximum: 100 },
        decision: { type: 'string', enum: Object.values(FRAUD_DECISION) },
        triggeredRules: { type: 'array', items: { type: 'string' } },
      },
    },
    allowedTransitions: {
      type: 'array',
      items: { type: 'string', enum: Object.values(PAYMENT_STATUS) },
      description: 'States reachable from the current one — drives client-side affordances',
    },
    createdAt: { type: 'string', format: 'date-time' },
  },
};

const spec = {
  openapi: '3.0.3',
  info: {
    title: 'PayFlux Payment Gateway API',
    version: '1.0.0',
    description: `
Distributed payment orchestration API.

## Idempotency
Every mutating payment endpoint **requires** an \`Idempotency-Key\` header.
Retrying with the same key and the same body replays the original response
instead of charging again. Reusing a key with a *different* body returns
\`422 IDEMPOTENCY_KEY_REUSE\`, and a retry arriving while the first request is
still executing returns \`409 IDEMPOTENT_REQUEST_IN_FLIGHT\` — back off and
retry.

## Money
All amounts are **integers in the currency's minor unit**. \`150000\` in INR is
₹1,500.00. Decimal amounts are rejected: floating-point cannot represent them
exactly, and a ledger that drifts by a cent fails reconciliation.

## Errors
Every error carries a stable \`code\`. A response with \`x-retryable: true\`
may succeed if retried after a backoff; anything else will not.

## Correlation
Every response echoes \`x-correlation-id\`. Quote it in a support request and
the whole trace can be recovered from the logs.
    `.trim(),
    contact: { name: 'PayFlux Platform Team' },
    license: { name: 'MIT' },
  },
  servers: [
    { url: `http://localhost:${config.port}${config.apiPrefix}/v1`, description: 'Local' },
    { url: `https://api.payflux.io${config.apiPrefix}/v1`, description: 'Production' },
  ],
  tags: [
    { name: 'Auth', description: 'Authentication and session management' },
    { name: 'Payments', description: 'Create, verify, cancel and list payments' },
    { name: 'Refunds', description: 'Full and partial refunds' },
    { name: 'Settlements', description: 'Payout batches' },
    { name: 'Webhooks', description: 'Event subscriptions and delivery inspection' },
    { name: 'Ledger', description: 'Double-entry ledger and reconciliation' },
    { name: 'Analytics', description: 'Dashboard metrics' },
    { name: 'Fraud', description: 'Risk decisions and alerts' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    parameters: {
      IdempotencyKey: {
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        schema: { type: 'string', minLength: 8, maxLength: 255 },
        description: 'A unique key per logical operation, e.g. a UUID v4.',
        example: '8f14e45f-ceea-467a-9a3f-1b2c3d4e5f60',
      },
      Page: { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
      Limit: { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
    },
    schemas: {
      Payment: paymentSchema,
      Error: errorResponse,
      CreatePaymentRequest: {
        type: 'object',
        required: ['amountMinor', 'currency', 'method'],
        properties: {
          amountMinor: { type: 'integer', minimum: 1, example: 150000 },
          currency: { type: 'string', enum: Object.values(CURRENCY), example: 'INR' },
          method: { type: 'string', enum: Object.values(PAYMENT_METHOD), example: 'CARD' },
          customer: {
            type: 'object',
            properties: {
              customerId: { type: 'string' },
              email: { type: 'string', format: 'email' },
              contact: { type: 'string' },
              last4: { type: 'string', pattern: '^[0-9]{4}$' },
              country: { type: 'string', minLength: 2, maxLength: 2 },
            },
          },
          description: { type: 'string', maxLength: 500 },
          notes: { type: 'object', additionalProperties: { type: 'string' } },
        },
      },
      CreateRefundRequest: {
        type: 'object',
        properties: {
          amountMinor: {
            type: 'integer',
            minimum: 1,
            description: 'Omit to refund the full remaining balance',
          },
          reason: {
            type: 'string',
            enum: ['REQUESTED_BY_CUSTOMER', 'DUPLICATE', 'FRAUDULENT', 'CHARGEBACK', 'MERCHANT_ERROR', 'OTHER'],
          },
          notes: { type: 'string', maxLength: 500 },
        },
      },
      Refund: {
        type: 'object',
        properties: {
          refundId: { type: 'string', example: 'rfnd_3xK9mP2qR7tV1wY5zA8b' },
          paymentId: { type: 'string' },
          status: { type: 'string', enum: Object.values(REFUND_STATUS) },
          amountMinor: { type: 'integer' },
          isFullRefund: { type: 'boolean' },
        },
      },
    },
    responses: {
      Unauthorized: { description: 'Missing or invalid credentials', content: { 'application/json': { schema: errorResponse } } },
      Forbidden: { description: 'Authenticated but not permitted', content: { 'application/json': { schema: errorResponse } } },
      NotFound: { description: 'Resource not found', content: { 'application/json': { schema: errorResponse } } },
      Conflict: { description: 'Conflicting state or in-flight idempotent request', content: { 'application/json': { schema: errorResponse } } },
      RateLimited: { description: 'Quota exceeded — see Retry-After', content: { 'application/json': { schema: errorResponse } } },
    },
  },
  security: [{ bearerAuth: [] }],
  paths: {
    '/auth/login': {
      post: {
        tags: ['Auth'],
        summary: 'Exchange credentials for a token pair',
        security: [],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['email', 'password'],
                properties: {
                  email: { type: 'string', format: 'email', example: 'admin@payflux.io' },
                  password: { type: 'string', example: 'AdminPassw0rd!' },
                },
              },
            },
          },
        },
        responses: {
          200: { description: 'Signed in' },
          401: { $ref: '#/components/responses/Unauthorized' },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
    },
    '/payments': {
      post: {
        tags: ['Payments'],
        summary: 'Create a payment',
        description: 'Idempotent. Scores the attempt for fraud, then authorises with the acquirer.',
        parameters: [{ $ref: '#/components/parameters/IdempotencyKey' }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreatePaymentRequest' } } },
        },
        responses: {
          201: { description: 'Payment created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Payment' } } } },
          402: { description: 'Blocked by the risk engine', content: { 'application/json': { schema: errorResponse } } },
          409: { $ref: '#/components/responses/Conflict' },
          422: { description: 'Idempotency key reused with a different payload' },
          429: { $ref: '#/components/responses/RateLimited' },
        },
      },
      get: {
        tags: ['Payments'],
        summary: 'List payments',
        parameters: [
          { $ref: '#/components/parameters/Page' },
          { $ref: '#/components/parameters/Limit' },
          { name: 'status', in: 'query', schema: { type: 'string' }, description: 'Comma-separated statuses' },
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
        ],
        responses: { 200: { description: 'A page of payments' } },
      },
    },
    '/payments/{paymentId}': {
      get: {
        tags: ['Payments'],
        summary: 'Fetch a payment',
        parameters: [{ name: 'paymentId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'The payment', content: { 'application/json': { schema: { $ref: '#/components/schemas/Payment' } } } },
          404: { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/payments/{paymentId}/verify': {
      post: {
        tags: ['Payments'],
        summary: 'Verify (and reconcile) a payment',
        description: 'Safe to poll. Reconciles a payment stuck in PROCESSING against the acquirer.',
        parameters: [{ name: 'paymentId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'Current authoritative state' } },
      },
    },
    '/payments/{paymentId}/cancel': {
      post: {
        tags: ['Payments'],
        summary: 'Cancel an uncaptured payment',
        parameters: [{ name: 'paymentId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Cancelled' },
          409: { description: 'Illegal state transition' },
        },
      },
    },
    '/payments/{paymentId}/refunds': {
      post: {
        tags: ['Refunds'],
        summary: 'Refund a payment in full or in part',
        parameters: [
          { name: 'paymentId', in: 'path', required: true, schema: { type: 'string' } },
          { $ref: '#/components/parameters/IdempotencyKey' },
        ],
        requestBody: {
          content: { 'application/json': { schema: { $ref: '#/components/schemas/CreateRefundRequest' } } },
        },
        responses: {
          201: { description: 'Refund created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Refund' } } } },
          422: { description: 'Refund would exceed the refundable balance' },
        },
      },
    },
    '/transactions': {
      get: {
        tags: ['Payments'],
        summary: 'Transaction history',
        parameters: [
          { $ref: '#/components/parameters/Page' },
          { $ref: '#/components/parameters/Limit' },
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Prefix search on transaction or source id' },
        ],
        responses: { 200: { description: 'A page of transactions' } },
      },
    },
    '/settlements': {
      get: { tags: ['Settlements'], summary: 'List settlement batches', responses: { 200: { description: 'OK' } } },
    },
    '/settlements/queue': {
      get: { tags: ['Settlements'], summary: 'Settlements awaiting payout', responses: { 200: { description: 'OK' } } },
    },
    '/settlements/run': {
      post: {
        tags: ['Settlements'],
        summary: 'Trigger a settlement build (ADMIN)',
        responses: { 201: { description: 'Batch created' }, 403: { $ref: '#/components/responses/Forbidden' } },
      },
    },
    '/webhooks/endpoints': {
      post: {
        tags: ['Webhooks'],
        summary: 'Register an endpoint',
        description: 'The signing secret is returned once and never again.',
        responses: { 201: { description: 'Endpoint created' } },
      },
      get: { tags: ['Webhooks'], summary: 'List endpoints', responses: { 200: { description: 'OK' } } },
    },
    '/webhooks/deliveries': {
      get: { tags: ['Webhooks'], summary: 'Delivery attempts', responses: { 200: { description: 'OK' } } },
    },
    '/webhooks/dead-letter': {
      get: { tags: ['Webhooks'], summary: 'Dead-lettered deliveries', responses: { 200: { description: 'OK' } } },
    },
    '/webhooks/deliveries/{deliveryId}/replay': {
      post: {
        tags: ['Webhooks'],
        summary: 'Replay a dead-lettered delivery',
        parameters: [{ name: 'deliveryId', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 201: { description: 'Replay queued' } },
      },
    },
    '/ledger/balance': {
      get: { tags: ['Ledger'], summary: 'Merchant payable balance', responses: { 200: { description: 'OK' } } },
    },
    '/ledger/trial-balance': {
      get: {
        tags: ['Ledger'],
        summary: 'Trial balance',
        description: 'Total debits and credits. These are equal in a correct ledger.',
        responses: { 200: { description: 'OK' } },
      },
    },
    '/ledger/reconciliations': {
      get: { tags: ['Ledger'], summary: 'Reconciliation history', responses: { 200: { description: 'OK' } } },
      post: { tags: ['Ledger'], summary: 'Run reconciliation now (ADMIN)', responses: { 200: { description: 'Report' } } },
    },
    '/analytics/overview': {
      get: {
        tags: ['Analytics'],
        summary: 'Dashboard headline metrics',
        parameters: [{ name: 'range', in: 'query', schema: { type: 'string', enum: ['1h', '24h', '7d', '30d', '90d'] } }],
        responses: { 200: { description: 'OK' } },
      },
    },
    '/analytics/timeseries': {
      get: { tags: ['Analytics'], summary: 'Payment volume over time', responses: { 200: { description: 'OK' } } },
    },
    '/fraud/alerts': {
      get: { tags: ['Fraud'], summary: 'Risk alerts (BLOCK/REVIEW)', responses: { 200: { description: 'OK' } } },
    },
  },
  'x-events': {
    description: 'Event types delivered to registered webhook endpoints',
    types: Object.values(EVENT),
  },
};

module.exports = spec;
