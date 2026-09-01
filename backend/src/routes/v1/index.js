'use strict';

const { Router } = require('express');
const { ROLE } = require('../../constants');
const middlewares = require('../../middlewares');
const validators = require('../../validators');

const paymentController = require('../../controllers/payment.controller');
const refundController = require('../../controllers/refund.controller');
const authController = require('../../controllers/auth.controller');
const settlementController = require('../../controllers/settlement.controller');
const webhookController = require('../../controllers/webhook.controller');
const analyticsController = require('../../controllers/analytics.controller');

const { authenticate, authorize, scopeToMerchant, requireMerchantContext, denyReadOnlyRoles } =
  middlewares.auth;
const validate = middlewares.validate;
const { idempotency } = middlewares;
const rateLimit = middlewares.rateLimit;

/**
 * API v1 routes.
 *
 * ── Middleware ordering ────────────────────────────────────────────────────
 * The order below is a security property, not a style choice:
 *
 *   rateLimit → authenticate → authorize → scope → validate → idempotency → handler
 *
 *   • rate limiting first, so an unauthenticated flood is rejected before it
 *     costs a database round trip;
 *   • authenticate before authorize, since roles come from the token;
 *   • scope before validate, because the tenant filter must exist before any
 *     handler can read data;
 *   • idempotency last, so the claim is only taken for a request that has
 *     already passed authentication and validation — otherwise a malformed
 *     request would burn its own key.
 */
const router = Router();

// ── Auth ────────────────────────────────────────────────────────────────
const auth = Router();
auth.post('/login', rateLimit.auth(), validate(validators.auth.login), authController.login);
auth.post('/refresh', validate(validators.auth.refresh), authController.refresh);
auth.post('/logout', authenticate, authController.logout);
auth.get('/me', authenticate, authController.me);
auth.post('/change-password',
  authenticate,
  validate(validators.auth.changePassword),
  authController.changePassword);
auth.post('/register',
  authenticate,
  authorize(ROLE.ADMIN),
  scopeToMerchant,
  validate(validators.auth.register),
  authController.register);
router.use('/auth', auth);

// ── Payments ────────────────────────────────────────────────────────────
const payments = Router();

// Published before the `/:paymentId` routes so the literal path is not
// swallowed by the parameterised one.
payments.get('/state-machine', authenticate, analyticsController.stateMachine);

payments.post('/',
  authenticate,
  authorize(ROLE.MERCHANT, ROLE.ADMIN),
  denyReadOnlyRoles,
  scopeToMerchant,
  requireMerchantContext,
  rateLimit.payments(),
  validate(validators.payment.createPayment),
  idempotency({ required: true }),
  paymentController.create);

payments.get('/',
  authenticate,
  scopeToMerchant,
  validate(validators.payment.listPayments, 'query'),
  paymentController.list);

payments.get('/:paymentId',
  authenticate,
  scopeToMerchant,
  validate(validators.payment.paymentIdParam, 'params'),
  paymentController.get);

payments.post('/:paymentId/verify',
  authenticate,
  scopeToMerchant,
  requireMerchantContext,
  validate(validators.payment.paymentIdParam, 'params'),
  validate(validators.payment.verifyPayment),
  paymentController.verify);

payments.post('/:paymentId/cancel',
  authenticate,
  authorize(ROLE.MERCHANT, ROLE.ADMIN),
  denyReadOnlyRoles,
  scopeToMerchant,
  requireMerchantContext,
  validate(validators.payment.paymentIdParam, 'params'),
  validate(validators.payment.cancelPayment),
  idempotency({ required: false }),
  paymentController.cancel);

// Refunds are nested under the payment they reverse — the URL states the
// relationship, and the payment id is always present for the lock key.
payments.post('/:paymentId/refunds',
  authenticate,
  authorize(ROLE.MERCHANT, ROLE.ADMIN),
  denyReadOnlyRoles,
  scopeToMerchant,
  requireMerchantContext,
  rateLimit.payments(),
  validate(validators.payment.paymentIdParam, 'params'),
  validate(validators.refund.createRefund),
  idempotency({ required: true }),
  refundController.create);

router.use('/payments', payments);

// ── Refunds (read side) ─────────────────────────────────────────────────
const refunds = Router();
refunds.get('/',
  authenticate, scopeToMerchant,
  validate(validators.refund.listRefunds, 'query'),
  refundController.list);
refunds.get('/:refundId',
  authenticate, scopeToMerchant,
  validate(validators.refund.refundIdParam, 'params'),
  refundController.get);
router.use('/refunds', refunds);

// ── Transactions ────────────────────────────────────────────────────────
router.get('/transactions',
  authenticate,
  scopeToMerchant,
  validate(validators.payment.transactionHistory, 'query'),
  paymentController.transactions);

// ── Settlements ─────────────────────────────────────────────────────────
const settlements = Router();
settlements.get('/', authenticate, scopeToMerchant,
  validate(validators.settlement.list, 'query'), settlementController.list);
settlements.get('/queue', authenticate, scopeToMerchant, settlementController.queue);
settlements.post('/run',
  authenticate,
  authorize(ROLE.ADMIN),
  validate(validators.settlement.trigger),
  settlementController.trigger);
settlements.get('/:settlementId',
  authenticate, scopeToMerchant,
  validate(validators.settlement.idParam, 'params'),
  settlementController.get);
router.use('/settlements', settlements);

// ── Webhooks ────────────────────────────────────────────────────────────
const webhooks = Router();
webhooks.post('/endpoints',
  authenticate, authorize(ROLE.MERCHANT, ROLE.ADMIN), denyReadOnlyRoles,
  scopeToMerchant, requireMerchantContext,
  validate(validators.webhook.createEndpoint),
  webhookController.createEndpoint);
webhooks.get('/endpoints',
  authenticate, scopeToMerchant, requireMerchantContext,
  webhookController.listEndpoints);
webhooks.patch('/endpoints/:endpointId',
  authenticate, authorize(ROLE.MERCHANT, ROLE.ADMIN), denyReadOnlyRoles,
  scopeToMerchant, requireMerchantContext,
  validate(validators.webhook.endpointIdParam, 'params'),
  validate(validators.webhook.updateEndpoint),
  webhookController.updateEndpoint);
webhooks.post('/endpoints/:endpointId/rotate-secret',
  authenticate, authorize(ROLE.MERCHANT, ROLE.ADMIN), denyReadOnlyRoles,
  scopeToMerchant, requireMerchantContext,
  validate(validators.webhook.endpointIdParam, 'params'),
  webhookController.rotateSecret);
webhooks.get('/deliveries',
  authenticate, scopeToMerchant,
  validate(validators.webhook.listDeliveries, 'query'),
  webhookController.listDeliveries);
webhooks.get('/dead-letter',
  authenticate, scopeToMerchant,
  validate(validators.webhook.listDeliveries, 'query'),
  webhookController.deadLetterQueue);
webhooks.post('/deliveries/:deliveryId/replay',
  authenticate, authorize(ROLE.ADMIN, ROLE.MERCHANT), denyReadOnlyRoles,
  scopeToMerchant,
  validate(validators.webhook.deliveryIdParam, 'params'),
  webhookController.replay);

// Inbound acquirer callbacks are authenticated by HMAC signature, not by a
// bearer token — the sender is a machine that has no session.
webhooks.post('/inbound/:provider', webhookController.receiveInbound);
router.use('/webhooks', webhooks);

// ── Analytics ───────────────────────────────────────────────────────────
const analytics = Router();
analytics.get('/overview', authenticate, scopeToMerchant,
  validate(validators.analytics.query, 'query'), analyticsController.overview);
analytics.get('/timeseries', authenticate, scopeToMerchant,
  validate(validators.analytics.query, 'query'), analyticsController.timeSeries);
router.use('/analytics', analytics);

// ── Fraud ───────────────────────────────────────────────────────────────
const fraud = Router();
fraud.get('/alerts', authenticate, scopeToMerchant,
  validate(validators.fraud.list, 'query'), analyticsController.fraudAlerts);
fraud.get('/analytics', authenticate, scopeToMerchant,
  validate(validators.analytics.query, 'query'), analyticsController.fraudAnalytics);
fraud.post('/alerts/:fraudLogId/review',
  authenticate, authorize(ROLE.ADMIN, ROLE.SUPPORT),
  validate(validators.fraud.review),
  analyticsController.reviewAlert);
router.use('/fraud', fraud);

// ── Ledger ──────────────────────────────────────────────────────────────
const ledger = Router();
ledger.get('/balance', authenticate, scopeToMerchant, requireMerchantContext,
  validate(validators.ledger.statement, 'query'), analyticsController.balance);
ledger.get('/accounts/:code/statement', authenticate, authorize(ROLE.ADMIN, ROLE.SUPPORT),
  validate(validators.ledger.statement, 'query'), analyticsController.statement);
ledger.get('/entries/:type/:id', authenticate, scopeToMerchant,
  analyticsController.entriesForReference);
ledger.get('/trial-balance', authenticate, authorize(ROLE.ADMIN, ROLE.SUPPORT),
  validate(validators.ledger.trialBalance, 'query'), analyticsController.trialBalance);
ledger.get('/reconciliations', authenticate, authorize(ROLE.ADMIN, ROLE.SUPPORT),
  analyticsController.reconciliations);
ledger.post('/reconciliations', authenticate, authorize(ROLE.ADMIN),
  analyticsController.runReconciliation);
router.use('/ledger', ledger);

// ── Audit ───────────────────────────────────────────────────────────────
router.get('/audit-logs',
  authenticate,
  authorize(ROLE.ADMIN, ROLE.SUPPORT),
  scopeToMerchant,
  validate(validators.audit.list, 'query'),
  analyticsController.auditLogs);

module.exports = router;
