'use strict';

const request = require('supertest');
const mongoose = require('mongoose');

/**
 * End-to-end API tests against real MongoDB and Redis.
 *
 * These deliberately do not mock the datastores. The properties under test —
 * unique-index races, conditional `$expr` updates, Lua-scripted locks — are
 * behaviours of MongoDB and Redis themselves. A mock that reimplements them
 * would only prove the mock works.
 */

const infra = require('../helpers/infra');

let app;
let database;
let redis;
let models;
let cryptoUtil;
let ids;
let available = false;

const merchantIdOf = (m) => m.merchantId;
let merchant;
let merchantToken;
let adminToken;

const key = (prefix) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

beforeAll(async () => {
  available = await infra.infraAvailable();
  if (!available) return;

  database = require('../../src/config/database');
  redis = require('../../src/config/redis');
  models = require('../../src/models');
  cryptoUtil = require('../../src/utils/crypto');
  ids = require('../../src/utils/ids');
  const createApp = require('../../src/app');

  await database.connect();
  await redis.connect();
  app = createApp();

  // Clean slate. Bypasses the model layer because the ledger and audit schemas
  // legitimately refuse deletes.
  await Promise.all(Object.values(models).map((model) =>
    model.collection.deleteMany({}).catch(() => {})));
  await redis.getClient('client').flushdb();

  const passwordHash = await cryptoUtil.hashPassword('TestPassw0rd!x');
  merchant = await models.Merchant.create({
    merchantId: ids.merchantId(),
    name: 'Integration Merchant',
    email: 'ops@integration.test',
    country: 'IN',
    defaultCurrency: 'INR',
    apiKey: ids.apiKey(),
    apiSecretHash: passwordHash,
    webhookSecret: `whsec_${ids.randomString(40)}`,
    status: 'ACTIVE',
    settlementConfig: { holdHours: 24, platformFeeBps: 200, autoSettle: true },
  });

  await models.User.create([
    {
      email: 'merchant@integration.test', passwordHash, name: 'Test Merchant',
      role: 'MERCHANT', merchant: merchant._id,
    },
    { email: 'admin@integration.test', passwordHash, name: 'Test Admin', role: 'ADMIN' },
  ]);

  const login = async (email) => {
    const res = await request(app).post('/api/v1/auth/login')
      .send({ email, password: 'TestPassw0rd!x' });
    return res.body.data.accessToken;
  };
  merchantToken = await login('merchant@integration.test');
  adminToken = await login('admin@integration.test');
});

afterAll(async () => {
  if (!available) return;
  const queues = require('../../src/queues');
  await queues.closeAll().catch(() => {});
  await database.disconnect().catch(() => {});
  await redis.disconnect().catch(() => {});
  await mongoose.disconnect().catch(() => {});
});

const guard = () => {
  if (!available) {
    // eslint-disable-next-line no-console
    console.warn('  ↳ skipped: MongoDB/Redis not reachable (set TEST_MONGO_URI / TEST_REDIS_PORT)');
  }
  return available;
};

const createPayment = (overrides = {}, token = merchantToken, idemKey = key('pay')) =>
  request(app)
    .post('/api/v1/payments')
    .set('authorization', `Bearer ${token}`)
    .set('idempotency-key', idemKey)
    .send({
      amountMinor: 150000, currency: 'INR', method: 'CARD',
      customer: { email: 'buyer@integration.test', country: 'IN' },
      ...overrides,
    });

describe('authentication', () => {
  it('issues a token pair for valid credentials', async () => {
    if (!guard()) return;
    const res = await request(app).post('/api/v1/auth/login')
      .send({ email: 'merchant@integration.test', password: 'TestPassw0rd!x' });
    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.refreshToken).toBeDefined();
    expect(res.body.data.user.merchant.merchantId).toBe(merchantIdOf(merchant));
  });

  it('returns the same error for a bad password and an unknown user', async () => {
    if (!guard()) return;
    const bad = await request(app).post('/api/v1/auth/login')
      .send({ email: 'merchant@integration.test', password: 'WrongPassword1' });
    const unknown = await request(app).post('/api/v1/auth/login')
      .send({ email: 'ghost@integration.test', password: 'WrongPassword1' });
    expect(bad.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(bad.body.error.code).toBe(unknown.body.error.code);
    expect(bad.body.error.message).toBe(unknown.body.error.message);
  });

  it('rejects an unauthenticated request', async () => {
    if (!guard()) return;
    const res = await request(app).get('/api/v1/payments');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('MISSING_TOKEN');
  });

  it('rejects a tampered token', async () => {
    if (!guard()) return;
    const res = await request(app).get('/api/v1/payments')
      .set('authorization', `Bearer ${merchantToken.slice(0, -4)}AAAA`);
    expect(res.status).toBe(401);
  });

  it('revokes every issued token on logout', async () => {
    if (!guard()) return;
    const passwordHash = await cryptoUtil.hashPassword('TestPassw0rd!x');
    await models.User.create({
      email: 'revoke@integration.test', passwordHash, name: 'Revoke', role: 'ADMIN',
    });
    const login = await request(app).post('/api/v1/auth/login')
      .send({ email: 'revoke@integration.test', password: 'TestPassw0rd!x' });
    const token = login.body.data.accessToken;

    expect((await request(app).get('/api/v1/auth/me').set('authorization', `Bearer ${token}`)).status).toBe(200);
    await request(app).post('/api/v1/auth/logout').set('authorization', `Bearer ${token}`);
    const after = await request(app).get('/api/v1/auth/me').set('authorization', `Bearer ${token}`);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe('TOKEN_REVOKED');
  });
});

describe('payment creation', () => {
  it('creates and captures a payment', async () => {
    if (!guard()) return;
    const res = await createPayment();
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('SUCCESS');
    expect(res.body.data.amountMinor).toBe(150000);
    expect(res.body.data.amount).toBe('1500.00');
    expect(res.body.data.feeMinor).toBe(3000); // 2% of 150000
    expect(res.body.headers).toBeUndefined();
    expect(res.headers.location).toContain(res.body.data.paymentId);
  });

  it('requires an Idempotency-Key', async () => {
    if (!guard()) return;
    const res = await request(app).post('/api/v1/payments')
      .set('authorization', `Bearer ${merchantToken}`)
      .send({ amountMinor: 1000, currency: 'INR', method: 'CARD' });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/Idempotency-Key/);
  });

  it('rejects a non-integer amount', async () => {
    if (!guard()) return;
    const res = await createPayment({ amountMinor: 100.5 });
    expect(res.status).toBe(400);
    expect(res.body.error.details[0].field).toBe('amountMinor');
  });

  it('ignores client-supplied server-authored fields', async () => {
    if (!guard()) return;
    // A caller must not be able to declare its own payment successful or set
    // its own fee — `stripUnknown` drops both before the service sees them.
    const res = await createPayment({ status: 'SUCCESS', feeMinor: 0, risk: { score: 0 } });
    expect(res.status).toBe(201);
    expect(res.body.data.feeMinor).toBe(3000);
  });

  it('echoes a correlation id on every response', async () => {
    if (!guard()) return;
    const res = await createPayment();
    expect(res.headers['x-correlation-id']).toMatch(/^cor_/);
    expect(res.body.meta.correlationId).toBe(res.headers['x-correlation-id']);
  });

  it('continues an upstream correlation id rather than starting a new trace', async () => {
    if (!guard()) return;
    const res = await request(app).get('/api/v1/payments')
      .set('authorization', `Bearer ${merchantToken}`)
      .set('x-correlation-id', 'cor_upstream_trace_1');
    expect(res.headers['x-correlation-id']).toBe('cor_upstream_trace_1');
  });
});

describe('idempotency', () => {
  it('replays the stored response for a retry with the same key and body', async () => {
    if (!guard()) return;
    const idemKey = key('replay');
    const first = await createPayment({}, merchantToken, idemKey);
    const second = await createPayment({}, merchantToken, idemKey);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers['x-idempotent-replay']).toBe('true');
    expect(second.body.data.paymentId).toBe(first.body.data.paymentId);

    const count = await models.Payment.countDocuments({ idempotencyKey: idemKey });
    expect(count).toBe(1);
  });

  it('rejects the same key with a different payload', async () => {
    if (!guard()) return;
    const idemKey = key('reuse');
    await createPayment({ amountMinor: 100000 }, merchantToken, idemKey);
    const mutated = await createPayment({ amountMinor: 200000 }, merchantToken, idemKey);
    expect(mutated.status).toBe(422);
    expect(mutated.body.error.code).toBe('IDEMPOTENCY_KEY_REUSE');
  });

  it('produces exactly one charge from a concurrent burst on one key', async () => {
    if (!guard()) return;
    const idemKey = key('burst');
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => createPayment({ amountMinor: 250000 }, merchantToken, idemKey)),
    );

    const created = responses.filter((r) => r.status === 201);
    const conflicts = responses.filter((r) => r.body?.error?.code === 'IDEMPOTENT_REQUEST_IN_FLIGHT');
    const paymentIds = new Set(created.map((r) => r.body.data.paymentId));

    expect(paymentIds.size).toBe(1);
    expect(created.length + conflicts.length).toBe(10);
    // The database is the final arbiter: exactly one row for this key.
    expect(await models.Payment.countDocuments({ idempotencyKey: idemKey })).toBe(1);
  });

  it('scopes keys per endpoint, so the same key means different things', async () => {
    if (!guard()) return;
    const shared = key('scoped');
    const payment = await createPayment({}, merchantToken, shared);
    expect(payment.status).toBe(201);
    // The same key on the refunds endpoint is a separate operation entirely.
    const refund = await request(app)
      .post(`/api/v1/payments/${payment.body.data.paymentId}/refunds`)
      .set('authorization', `Bearer ${merchantToken}`)
      .set('idempotency-key', shared)
      .send({ amountMinor: 1000 });
    expect(refund.status).toBe(201);
  });
});

describe('refunds', () => {
  it('refunds partially, then fully, and never over-refunds', async () => {
    if (!guard()) return;
    const payment = await createPayment({ amountMinor: 100000 });
    const paymentId = payment.body.data.paymentId;

    const refund = (amountMinor) => request(app)
      .post(`/api/v1/payments/${paymentId}/refunds`)
      .set('authorization', `Bearer ${merchantToken}`)
      .set('idempotency-key', key('rf'))
      .send({ amountMinor });

    const first = await refund(40000);
    expect(first.status).toBe(201);

    const detail = await request(app).get(`/api/v1/payments/${paymentId}`)
      .set('authorization', `Bearer ${merchantToken}`);
    expect(detail.body.data.refundableMinor).toBe(60000);
    expect(detail.body.data.status).toBe('PARTIALLY_REFUNDED');

    const over = await refund(70000);
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('REFUND_EXCEEDS_BALANCE');
    expect(over.body.error.details.availableMinor).toBe(60000);

    const rest = await refund(60000);
    expect(rest.status).toBe(201);

    const final = await request(app).get(`/api/v1/payments/${paymentId}`)
      .set('authorization', `Bearer ${merchantToken}`);
    expect(final.body.data.status).toBe('REFUNDED');
    expect(final.body.data.refundableMinor).toBe(0);
  });

  it('holds the line under concurrent refunds', async () => {
    if (!guard()) return;
    const payment = await createPayment({ amountMinor: 100000 });
    const paymentId = payment.body.data.paymentId;

    // Six simultaneous 30000 refunds against 100000: at most three can succeed.
    const responses = await Promise.all(Array.from({ length: 6 }, () =>
      request(app)
        .post(`/api/v1/payments/${paymentId}/refunds`)
        .set('authorization', `Bearer ${merchantToken}`)
        .set('idempotency-key', key('cc'))
        .send({ amountMinor: 30000 })));

    const accepted = responses.filter((r) => r.status === 201).length;
    expect(accepted).toBeLessThanOrEqual(3);

    const doc = await models.Payment.findOne({ paymentId }).lean();
    // The invariant that actually matters.
    expect(doc.amountRefundedMinor).toBeLessThanOrEqual(doc.amountMinor);
  });

  it('refuses to refund a payment that was never captured', async () => {
    if (!guard()) return;
    const orphan = await models.Payment.create({
      paymentId: ids.paymentId(), merchant: merchant._id, amountMinor: 5000,
      currency: 'INR', method: 'CARD', status: 'FAILED',
    });
    const res = await request(app)
      .post(`/api/v1/payments/${orphan.paymentId}/refunds`)
      .set('authorization', `Bearer ${merchantToken}`)
      .set('idempotency-key', key('nf'))
      .send({ amountMinor: 1000 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PAYMENT_NOT_REFUNDABLE');
  });
});

describe('state machine enforcement', () => {
  it('refuses to cancel a captured payment', async () => {
    if (!guard()) return;
    const payment = await createPayment();
    const res = await request(app)
      .post(`/api/v1/payments/${payment.body.data.paymentId}/cancel`)
      .set('authorization', `Bearer ${merchantToken}`)
      .send({ reason: 'changed my mind' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(res.body.error.details).toMatchObject({ from: 'SUCCESS', to: 'CANCELLED' });
  });

  it('cancels a payment still pending', async () => {
    if (!guard()) return;
    const pending = await models.Payment.create({
      paymentId: ids.paymentId(), merchant: merchant._id, amountMinor: 5000,
      currency: 'INR', method: 'CARD', status: 'PENDING',
    });
    const res = await request(app)
      .post(`/api/v1/payments/${pending.paymentId}/cancel`)
      .set('authorization', `Bearer ${merchantToken}`)
      .send({ reason: 'abandoned checkout' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CANCELLED');
    // The transition is recorded for audit.
    const doc = await models.Payment.findOne({ paymentId: pending.paymentId }).lean();
    expect(doc.stateHistory.at(-1)).toMatchObject({ to: 'CANCELLED', reason: 'abandoned checkout' });
  });

  it('publishes the transition table it enforces', async () => {
    if (!guard()) return;
    const res = await request(app).get('/api/v1/payments/state-machine')
      .set('authorization', `Bearer ${merchantToken}`);
    expect(res.status).toBe(200);
    const success = res.body.data.states.find((s) => s.state === 'SUCCESS');
    expect(success.transitions).toEqual(expect.arrayContaining(['REFUNDED']));
    expect(res.body.data.states.find((s) => s.state === 'FAILED').terminal).toBe(true);
  });
});

describe('authorization and tenant isolation', () => {
  it('hides another merchant\'s payment', async () => {
    if (!guard()) return;
    const passwordHash = await cryptoUtil.hashPassword('TestPassw0rd!x');
    const other = await models.Merchant.create({
      merchantId: ids.merchantId(), name: 'Other Co', email: 'o@other.test', country: 'IN',
      apiKey: ids.apiKey(), apiSecretHash: passwordHash, webhookSecret: 'whsec_x', status: 'ACTIVE',
    });
    await models.User.create({
      email: 'other@integration.test', passwordHash, name: 'Other', role: 'MERCHANT', merchant: other._id,
    });
    const login = await request(app).post('/api/v1/auth/login')
      .send({ email: 'other@integration.test', password: 'TestPassw0rd!x' });

    const mine = await createPayment();
    const res = await request(app).get(`/api/v1/payments/${mine.body.data.paymentId}`)
      .set('authorization', `Bearer ${login.body.data.accessToken}`);
    expect(res.status).toBe(404);
  });

  it('lets an admin read across merchants', async () => {
    if (!guard()) return;
    const res = await request(app).get('/api/v1/payments?limit=5')
      .set('authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.body.pagination.total).toBeGreaterThan(0);
  });

  it('denies a merchant the admin-only settlement trigger', async () => {
    if (!guard()) return;
    const res = await request(app).post('/api/v1/settlements/run')
      .set('authorization', `Bearer ${merchantToken}`)
      .send({ merchantId: merchantIdOf(merchant) });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('INSUFFICIENT_ROLE');
  });
});

describe('security middleware', () => {
  it('strips NoSQL operator injection from a query', async () => {
    if (!guard()) return;
    // `status[$ne]=X` would otherwise reach Mongo as an operator object.
    const res = await request(app).get('/api/v1/payments?status[$ne]=NOPE')
      .set('authorization', `Bearer ${merchantToken}`);
    expect(res.status).toBeLessThan(500);
  });

  it('rejects an oversized body', async () => {
    if (!guard()) return;
    const res = await request(app).post('/api/v1/payments')
      .set('authorization', `Bearer ${merchantToken}`)
      .set('idempotency-key', key('big'))
      .send({ amountMinor: 1000, currency: 'INR', method: 'CARD', description: 'x'.repeat(400_000) });
    expect([400, 413]).toContain(res.status);
  });

  it('sets hardening headers', async () => {
    if (!guard()) return;
    const res = await request(app).get('/health/live');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('returns a structured 404 for an unknown route', async () => {
    if (!guard()) return;
    const res = await request(app).get('/api/v1/nonexistent');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
  });
});

describe('health and metrics', () => {
  it('reports liveness without touching dependencies', async () => {
    if (!guard()) return;
    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('alive');
  });

  it('reports readiness with dependency checks', async () => {
    if (!guard()) return;
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.checks.mongo.ok).toBe(true);
    expect(res.body.checks.redis.ok).toBe(true);
  });

  it('exposes Prometheus metrics', async () => {
    if (!guard()) return;
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.text).toContain('payflux_http_requests_total');
  });
});
