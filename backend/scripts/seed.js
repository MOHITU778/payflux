'use strict';

/**
 * Development seed.
 *
 * Creates a realistic starting state: two merchants, one user per role, a
 * webhook endpoint, and a few weeks of payments/refunds with plausible status
 * and amount distributions — enough that every dashboard tile and chart has
 * something meaningful to render.
 *
 * Idempotent: re-running it wipes and rebuilds the seeded collections rather
 * than accumulating duplicates.
 */

const database = require('../src/config/database');
const redis = require('../src/config/redis');
const logger = require('../src/config/logger');
const models = require('../src/models');
const ids = require('../src/utils/ids');
const money = require('../src/utils/money');
const { hashPassword } = require('../src/utils/crypto');
const ledgerService = require('../src/services/ledger.service');
const {
  PAYMENT_STATUS, PAYMENT_METHOD, ROLE, FRAUD_DECISION, REFUND_STATUS,
} = require('../src/constants');

const log = logger.child({ component: 'seed' });

/** Weighted pick, so the seeded mix looks like real traffic. */
function weightedPick(entries) {
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let point = Math.random() * total;
  for (const [value, weight] of entries) {
    point -= weight;
    if (point <= 0) return value;
  }
  return entries[0][0];
}

const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const CUSTOMERS = [
  { email: 'priya.sharma@example.com', country: 'IN', network: 'VISA' },
  { email: 'arjun.mehta@example.com', country: 'IN', network: 'MASTERCARD' },
  { email: 'sara.oconnell@example.com', country: 'GB', network: 'VISA' },
  { email: 'chen.wei@example.com', country: 'SG', network: 'AMEX' },
  { email: 'test.user@mailinator.com', country: 'IN', network: 'RUPAY' },
  { email: 'devika.rao@example.com', country: 'IN', network: 'RUPAY' },
];

async function seed() {
  await database.connect();
  await redis.connect();

  log.info('clearing seeded collections');
  // Goes through the native driver rather than the model. The ledger-entry and
  // audit-log schemas install pre-hooks that refuse deletes — that guard is
  // working as intended, and a maintenance reset is the one legitimate reason
  // to step around it.
  await Promise.all(
    Object.values(models).map((model) =>
      model.collection.deleteMany({}).catch((err) => {
        if (err.codeName !== 'NamespaceNotFound') throw err;
      })),
  );
  await redis.getClient('client').flushdb();

  // ── Merchants ────────────────────────────────────────────────────────
  const merchants = await models.Merchant.create([
    {
      merchantId: ids.merchantId(),
      name: 'Nimbus Retail',
      email: 'ops@nimbusretail.example',
      country: 'IN',
      defaultCurrency: 'INR',
      apiKey: ids.apiKey(),
      apiSecretHash: await hashPassword('nimbus-secret-key'),
      webhookSecret: `whsec_${ids.randomString(40)}`,
      status: 'ACTIVE',
      riskProfile: { tier: 'MEDIUM', maxTransactionMinor: 50_000_000, blockedCountries: ['RU'] },
      settlementConfig: { holdHours: 24, platformFeeBps: 200, bankAccountLast4: '4417', autoSettle: true },
    },
    {
      merchantId: ids.merchantId(),
      name: 'Volt Mobility',
      email: 'finance@voltmobility.example',
      country: 'IN',
      defaultCurrency: 'INR',
      apiKey: ids.apiKey(),
      apiSecretHash: await hashPassword('volt-secret-key'),
      webhookSecret: `whsec_${ids.randomString(40)}`,
      status: 'ACTIVE',
      riskProfile: { tier: 'HIGH', maxTransactionMinor: 20_000_000 },
      settlementConfig: { holdHours: 48, platformFeeBps: 250, bankAccountLast4: '9082', autoSettle: true },
    },
  ]);
  log.info('merchants created', { count: merchants.length });

  // ── Users (one per role) ─────────────────────────────────────────────
  const password = await hashPassword('PayFlux#2024');
  const users = await models.User.create([
    { email: 'admin@payflux.io', passwordHash: password, name: 'Ada Admin', role: ROLE.ADMIN },
    { email: 'support@payflux.io', passwordHash: password, name: 'Sam Support', role: ROLE.SUPPORT },
    {
      email: 'merchant@nimbusretail.example',
      passwordHash: password,
      name: 'Nina Merchant',
      role: ROLE.MERCHANT,
      merchant: merchants[0]._id,
    },
    {
      email: 'merchant@voltmobility.example',
      passwordHash: password,
      name: 'Vik Merchant',
      role: ROLE.MERCHANT,
      merchant: merchants[1]._id,
    },
  ]);
  log.info('users created', { count: users.length });

  // ── Webhook endpoints ────────────────────────────────────────────────
  await models.WebhookEndpoint.create([
    {
      endpointId: ids.webhookEndpointId(),
      merchant: merchants[0]._id,
      url: 'https://webhook.site/nimbus-payflux-events',
      description: 'Production event sink',
      subscribedEvents: [],
      secret: `whsec_${ids.randomString(40)}`,
    },
    {
      endpointId: ids.webhookEndpointId(),
      merchant: merchants[1]._id,
      url: 'https://volt.example/hooks/payflux',
      description: 'Settlement notifications only',
      subscribedEvents: ['settlement.completed', 'payment.succeeded'],
      secret: `whsec_${ids.randomString(40)}`,
    },
  ]);

  // ── Payments across the last 30 days ─────────────────────────────────
  const PAYMENT_COUNT = 420;
  const payments = [];
  const now = Date.now();

  for (let i = 0; i < PAYMENT_COUNT; i += 1) {
    const merchant = merchants[Math.random() < 0.65 ? 0 : 1];
    const customer = CUSTOMERS[randomInt(0, CUSTOMERS.length - 1)];

    // Log-ish distribution: many small payments, a few large ones.
    const amountMinor = weightedPick([
      [randomInt(19900, 99900), 45],
      [randomInt(100000, 499900), 30],
      [randomInt(500000, 1999900), 18],
      [randomInt(2000000, 8000000), 7],
    ]);

    const status = weightedPick([
      [PAYMENT_STATUS.SUCCESS, 74],
      [PAYMENT_STATUS.FAILED, 14],
      [PAYMENT_STATUS.REFUNDED, 4],
      [PAYMENT_STATUS.PARTIALLY_REFUNDED, 3],
      [PAYMENT_STATUS.CANCELLED, 3],
      [PAYMENT_STATUS.PENDING, 2],
    ]);

    const method = weightedPick([
      [PAYMENT_METHOD.CARD, 52], [PAYMENT_METHOD.UPI, 33],
      [PAYMENT_METHOD.NETBANKING, 10], [PAYMENT_METHOD.WALLET, 5],
    ]);

    const createdAt = new Date(now - randomInt(0, 30 * 24 * 60) * 60_000);
    const terminal = status !== PAYMENT_STATUS.PENDING;
    const feeMinor = money.splitByBps(amountMinor, merchant.settlementConfig.platformFeeBps).fee;

    const riskScore = weightedPick([[randomInt(0, 25), 70], [randomInt(26, 55), 20], [randomInt(56, 95), 10]]);
    const decision = riskScore >= 80 ? FRAUD_DECISION.BLOCK
      : riskScore >= 50 ? FRAUD_DECISION.REVIEW : FRAUD_DECISION.ALLOW;

    const refundedMinor = status === PAYMENT_STATUS.REFUNDED
      ? amountMinor
      : status === PAYMENT_STATUS.PARTIALLY_REFUNDED
        ? Math.floor(amountMinor * (randomInt(20, 70) / 100))
        : 0;

    payments.push({
      paymentId: ids.paymentId(),
      merchant: merchant._id,
      amountMinor,
      currency: 'INR',
      amountRefundedMinor: refundedMinor,
      feeMinor,
      status,
      method,
      customer: {
        customerId: `cust_${customer.email.split('@')[0]}`,
        email: customer.email,
        last4: String(randomInt(1000, 9999)),
        network: customer.network,
        country: customer.country,
      },
      context: {
        ipAddress: `103.${randomInt(1, 250)}.${randomInt(1, 250)}.${randomInt(1, 250)}`,
        country: customer.country,
        userAgent: 'Mozilla/5.0 (seed)',
      },
      risk: { score: riskScore, decision, triggeredRules: riskScore > 50 ? ['HIGH_AMOUNT'] : [] },
      acquirer: status === PAYMENT_STATUS.SUCCESS || refundedMinor > 0
        ? { name: 'simulated-acquirer', referenceId: `acq_${ids.randomString(20)}`, authCode: ids.randomString(6).toUpperCase(), capturedAt: createdAt }
        : {},
      failure: status === PAYMENT_STATUS.FAILED
        ? {
          code: weightedPick([['INSUFFICIENT_FUNDS', 40], ['DO_NOT_HONOR', 25], ['CARD_EXPIRED', 15], ['INVALID_CVV', 12], ['LIMIT_EXCEEDED', 8]]),
          message: 'Declined by issuer',
          at: createdAt,
        }
        : {},
      description: `Order #${randomInt(10000, 99999)}`,
      createdAt,
      updatedAt: createdAt,
      completedAt: terminal ? createdAt : null,
      stateHistory: [{ from: 'NONE', to: status, reason: 'Seeded', actor: 'seed', at: createdAt }],
    });
  }

  const insertedPayments = await models.Payment.insertMany(payments);
  log.info('payments created', { count: insertedPayments.length });

  // ── Transaction feed projections ─────────────────────────────────────
  await models.Transaction.insertMany(
    insertedPayments.map((payment) => ({
      transactionId: ids.transactionId(),
      merchant: payment.merchant,
      type: 'PAYMENT',
      direction: 'CREDIT',
      amountMinor: payment.amountMinor,
      feeMinor: payment.feeMinor,
      netMinor: payment.amountMinor - payment.feeMinor,
      currency: payment.currency,
      status: payment.status,
      description: payment.description,
      sourceType: 'Payment',
      sourceId: payment.paymentId,
      occurredAt: payment.createdAt,
    })),
  );

  // ── Refunds for the refunded payments ────────────────────────────────
  const refundable = insertedPayments.filter((payment) => payment.amountRefundedMinor > 0);
  if (refundable.length) {
    await models.Refund.insertMany(refundable.map((payment) => ({
      refundId: ids.refundId(),
      payment: payment._id,
      paymentId: payment.paymentId,
      merchant: payment.merchant,
      amountMinor: payment.amountRefundedMinor,
      currency: payment.currency,
      status: REFUND_STATUS.SUCCESS,
      isFullRefund: payment.amountRefundedMinor === payment.amountMinor,
      reason: weightedPick([['REQUESTED_BY_CUSTOMER', 60], ['DUPLICATE', 15], ['MERCHANT_ERROR', 15], ['FRAUDULENT', 10]]),
      acquirerReferenceId: `acq_${ids.randomString(20)}`,
      processedAt: payment.createdAt,
      createdAt: payment.createdAt,
    })));
    log.info('refunds created', { count: refundable.length });
  }

  // ── Fraud logs ───────────────────────────────────────────────────────
  await models.FraudLog.insertMany(insertedPayments.slice(0, 160).map((payment) => ({
    fraudLogId: ids.fraudLogId(),
    merchant: payment.merchant,
    paymentId: payment.paymentId,
    riskScore: payment.risk.score,
    decision: payment.risk.decision,
    triggeredRules: payment.risk.score > 50
      ? [{
        ruleId: weightedPick([['HIGH_AMOUNT', 40], ['VELOCITY_CUSTOMER', 25], ['COUNTRY_MISMATCH', 20], ['DISPOSABLE_EMAIL', 15]]),
        ruleName: 'Seeded rule hit',
        weight: randomInt(15, 40),
        severity: weightedPick([['MEDIUM', 50], ['HIGH', 35], ['CRITICAL', 15]]),
      }]
      : [],
    signals: {
      amountMinor: payment.amountMinor,
      currency: payment.currency,
      ipAddress: payment.context.ipAddress,
      ipCountry: payment.context.country,
      customerEmail: payment.customer.email,
    },
    evaluationMs: randomInt(3, 45),
    createdAt: payment.createdAt,
  })));

  // ── Ledger: post real journals for the captured payments ─────────────
  // Uses the production posting path, so the seeded books are genuinely
  // balanced rather than fabricated — reconciliation runs clean on a fresh DB.
  // Every captured payment gets a journal, exactly as it would in production.
  // Capping this (an earlier version stopped at 150) left the settlements —
  // which are computed from ALL successful payments — paying out far more than
  // the ledger ever recorded as captured, driving the clearing account
  // negative. The books stayed internally balanced, but the seeded state was
  // economically impossible.
  const captured = insertedPayments.filter((payment) =>
    [PAYMENT_STATUS.SUCCESS, PAYMENT_STATUS.PARTIALLY_REFUNDED, PAYMENT_STATUS.REFUNDED]
      .includes(payment.status));

  for (const payment of captured) {
    const merchant = merchants.find((entry) => String(entry._id) === String(payment.merchant));
    await ledgerService.recordPaymentCapture({ payment, merchant }).catch((err) =>
      log.warn('ledger seed posting failed', { paymentId: payment.paymentId, error: err.message }));
  }
  log.info('ledger journals posted', { count: captured.length });

  // ── Settlements ──────────────────────────────────────────────────────
  for (const merchant of merchants) {
    const merchantPayments = insertedPayments.filter(
      (payment) => String(payment.merchant) === String(merchant._id)
        && payment.status === PAYMENT_STATUS.SUCCESS,
    );
    if (!merchantPayments.length) continue;

    const grossAmountMinor = money.sum(merchantPayments.map((p) => p.amountMinor));
    const feeAmountMinor = money.sum(merchantPayments.map((p) => p.feeMinor));
    const refundedAmountMinor = money.sum(merchantPayments.map((p) => p.amountRefundedMinor));

    await models.Settlement.create({
      settlementId: ids.settlementId(),
      merchant: merchant._id,
      currency: 'INR',
      periodStart: new Date(now - 7 * 24 * 3600e3),
      periodEnd: new Date(now - 24 * 3600e3),
      grossAmountMinor,
      refundedAmountMinor,
      feeAmountMinor,
      netAmountMinor: Math.max(0, grossAmountMinor - feeAmountMinor - refundedAmountMinor),
      paymentCount: merchantPayments.length,
      status: 'QUEUED',
      payout: { bankAccountLast4: merchant.settlementConfig.bankAccountLast4 },
      batchKey: `${merchant.merchantId}:INR:seed`,
    });
  }

  // ── Summary ──────────────────────────────────────────────────────────
  const summary = {
    merchants: merchants.length,
    users: users.length,
    payments: insertedPayments.length,
    refunds: refundable.length,
    ledgerJournals: captured.length,
  };
  log.info('seed complete', summary);

  /* eslint-disable no-console */
  console.log('\n────────────────────────────────────────────────────────');
  console.log('  PayFlux seed complete');
  console.log('────────────────────────────────────────────────────────');
  // Don't hard-code a port: the console is on 4200 under `ng serve` and on
  // CONSOLE_PORT under Docker.
  console.log('  Sign in to the console with:\n');
  console.log('    ADMIN     admin@payflux.io          / PayFlux#2024');
  console.log('    SUPPORT   support@payflux.io        / PayFlux#2024');
  console.log('    MERCHANT  merchant@nimbusretail.example / PayFlux#2024');
  console.log(`\n  Seeded: ${summary.payments} payments, ${summary.refunds} refunds, `
    + `${summary.ledgerJournals} ledger journals`);
  console.log('────────────────────────────────────────────────────────\n');
  /* eslint-enable no-console */

  await database.disconnect();
  await redis.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  log.error('seed failed', { error: err.message, stack: err.stack });
  process.exit(1);
});
