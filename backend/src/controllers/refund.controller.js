'use strict';

const refundService = require('../services/refund.service');
const asyncHandler = require('../utils/asyncHandler');
const { success, created, paginated } = require('../utils/apiResponse');
const { actorFrom } = require('./payment.controller');

module.exports = {
  /** POST /api/v1/payments/:paymentId/refunds — requires an Idempotency-Key. */
  create: asyncHandler(async (req, res) => {
    const refund = await refundService.createRefund({
      merchant: req.merchant,
      paymentId: req.params.paymentId,
      amountMinor: req.body.amountMinor,   // omitted ⇒ full remaining balance
      reason: req.body.reason,
      notes: req.body.notes,
      actor: actorFrom(req),
      idempotencyKey: req.idempotency?.key ?? null,
    });
    return created(res, refund, `/api/v1/refunds/${refund.refundId}`);
  }),

  /** GET /api/v1/refunds/:refundId */
  get: asyncHandler(async (req, res) => {
    const refund = await refundService.getRefund({
      merchant: req.merchant,
      refundId: req.params.refundId,
    });
    return success(res, refund);
  }),

  /** GET /api/v1/refunds */
  list: asyncHandler(async (req, res) => {
    const result = await refundService.listRefunds({
      merchantFilter: req.merchantFilter,
      query: req.query,
    });
    return paginated(res, result);
  }),
};
