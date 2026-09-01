'use strict';

const analyticsService = require('../services/analytics.service');
const fraudService = require('../services/fraud/fraud.service');
const reconciliationService = require('../services/reconciliation.service');
const ledgerService = require('../services/ledger.service');
const auditService = require('../services/audit.service');
const asyncHandler = require('../utils/asyncHandler');
const { success, paginated } = require('../utils/apiResponse');
const { paymentStateMachine } = require('../services/stateMachine.service');
const pagination = require('../utils/pagination');

module.exports = {
  /** GET /api/v1/analytics/overview — the dashboard's headline payload. */
  overview: asyncHandler(async (req, res) => {
    const data = await analyticsService.overview({
      merchantFilter: req.merchantFilter,
      query: req.query,
      currency: req.query.currency,
    });
    return success(res, data);
  }),

  /** GET /api/v1/analytics/timeseries — chart data. */
  timeSeries: asyncHandler(async (req, res) => {
    const data = await analyticsService.timeSeries({
      merchantFilter: req.merchantFilter,
      query: req.query,
      currency: req.query.currency,
    });
    return success(res, data);
  }),

  /** GET /api/v1/fraud/alerts */
  fraudAlerts: asyncHandler(async (req, res) => {
    const { page, limit } = pagination.normalize(req.query);
    const result = await fraudService.listAlerts(req.merchantFilter, {
      ...req.query,
      from: req.query.from ? new Date(req.query.from) : undefined,
      to: req.query.to ? new Date(req.query.to) : undefined,
      page,
      limit,
    });
    return paginated(res, result);
  }),

  /** GET /api/v1/fraud/analytics */
  fraudAnalytics: asyncHandler(async (req, res) => {
    const data = await analyticsService.fraudAnalytics({
      merchantFilter: req.merchantFilter,
      query: req.query,
    });
    return success(res, data);
  }),

  /** POST /api/v1/fraud/alerts/:fraudLogId/review — analyst override. */
  reviewAlert: asyncHandler(async (req, res) => {
    const updated = await fraudService.review(req.params.fraudLogId, {
      userId: req.user.id,
      decision: req.body.decision,
      notes: req.body.notes,
    });
    return success(res, updated, { message: 'Review recorded' });
  }),

  /** GET /api/v1/ledger/balance — what we currently owe this merchant. */
  balance: asyncHandler(async (req, res) => {
    const balance = await ledgerService.merchantBalance(req.merchant, req.query.currency ?? 'INR');
    return success(res, balance);
  }),

  /** GET /api/v1/ledger/accounts/:code/statement */
  statement: asyncHandler(async (req, res) => {
    const { page, limit } = pagination.normalize(req.query);
    const result = await ledgerService.statement(
      req.params.code, req.query.currency ?? 'INR', { page, limit },
    );
    return success(res, result);
  }),

  /** GET /api/v1/ledger/entries/:type/:id — every leg posted for one entity. */
  entriesForReference: asyncHandler(async (req, res) => {
    const entries = await ledgerService.entriesForReference(req.params.type, req.params.id);
    return success(res, entries);
  }),

  /** GET /api/v1/ledger/trial-balance — debits vs credits, must be equal. */
  trialBalance: asyncHandler(async (req, res) => {
    const data = await reconciliationService.trialBalance({
      currency: req.query.currency,
      from: req.query.from ? new Date(req.query.from) : undefined,
      to: req.query.to ? new Date(req.query.to) : undefined,
    });
    return success(res, data);
  }),

  /** GET /api/v1/ledger/reconciliations */
  reconciliations: asyncHandler(async (req, res) => {
    const { page, limit } = pagination.normalize(req.query);
    const result = await reconciliationService.list({ page, limit });
    return paginated(res, result);
  }),

  /** POST /api/v1/ledger/reconciliations — ADMIN only; runs a pass now. */
  runReconciliation: asyncHandler(async (req, res) => {
    const report = await reconciliationService.run({
      currency: req.body?.currency ?? 'INR',
      triggeredBy: req.user.email,
    });
    return success(res, report, { message: `Reconciliation ${report.status}` });
  }),

  /** GET /api/v1/audit-logs */
  auditLogs: asyncHandler(async (req, res) => {
    const result = await auditService.list({
      merchantFilter: req.merchantFilter,
      query: req.query,
    });
    return paginated(res, result);
  }),

  /**
   * GET /api/v1/payments/state-machine
   * Published so the console can derive its action buttons from the same
   * transition table the server enforces, instead of duplicating the rules.
   */
  stateMachine: asyncHandler(async (_req, res) => {
    return success(res, { states: paymentStateMachine.describe() });
  }),
};
