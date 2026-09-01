'use strict';

const settlementService = require('../services/settlement.service');
const asyncHandler = require('../utils/asyncHandler');
const { success, paginated, created } = require('../utils/apiResponse');
const { actorFrom } = require('./payment.controller');

module.exports = {
  /** GET /api/v1/settlements */
  list: asyncHandler(async (req, res) => {
    const result = await settlementService.listSettlements({
      merchantFilter: req.merchantFilter,
      query: req.query,
    });
    return paginated(res, result);
  }),

  /** GET /api/v1/settlements/queue — the dashboard's settlement-queue tile. */
  queue: asyncHandler(async (req, res) => {
    const queue = await settlementService.queue(req.merchantFilter);
    return success(res, queue);
  }),

  /** GET /api/v1/settlements/:settlementId */
  get: asyncHandler(async (req, res) => {
    const settlement = await settlementService.getSettlement({
      merchant: req.merchant,
      settlementId: req.params.settlementId,
    });
    return success(res, settlement);
  }),

  /** POST /api/v1/settlements/run — ADMIN only; forces a batch build. */
  trigger: asyncHandler(async (req, res) => {
    const settlement = await settlementService.triggerManual({
      merchantId: req.body.merchantId,
      currency: req.body.currency,
      actor: actorFrom(req),
    });
    if (!settlement) {
      return success(res, null, { message: 'No payments are eligible for settlement' });
    }
    return created(res, settlementService.toViewModel(settlement));
  }),
};
