'use strict';

const paymentService = require('../services/payment.service');
const asyncHandler = require('../utils/asyncHandler');
const { success, created, paginated } = require('../utils/apiResponse');

/**
 * Payment HTTP handlers.
 *
 * Controllers are deliberately thin: translate HTTP into a service call, and a
 * service result into an HTTP response. No business rules live here, which is
 * what lets the same services be driven by a queue worker or a CLI without
 * dragging Express along.
 */

/** Everything the service needs to know about *who* is calling. */
function actorFrom(req) {
  return {
    userId: req.user?.id,
    email: req.user?.email,
    role: req.user?.role,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  };
}

module.exports = {
  /** POST /api/v1/payments — requires an Idempotency-Key. */
  create: asyncHandler(async (req, res) => {
    const payment = await paymentService.createPayment({
      merchant: req.merchant,
      dto: req.body,
      actor: actorFrom(req),
      idempotencyKey: req.idempotency?.key ?? null,
    });
    return created(res, payment, `${req.baseUrl}/${payment.paymentId}`);
  }),

  /** GET /api/v1/payments/:paymentId */
  get: asyncHandler(async (req, res) => {
    const payment = await paymentService.getPayment({
      merchant: req.merchant,
      paymentId: req.params.paymentId,
    });
    return success(res, payment);
  }),

  /**
   * POST /api/v1/payments/:paymentId/verify
   * Safe to poll: reconciles an indeterminate payment against the acquirer.
   */
  verify: asyncHandler(async (req, res) => {
    const payment = await paymentService.verifyPayment({
      merchant: req.merchant,
      paymentId: req.params.paymentId,
      reconcile: req.body?.reconcile ?? true,
    });
    return success(res, payment, { message: `Payment is ${payment.status}` });
  }),

  /** POST /api/v1/payments/:paymentId/cancel */
  cancel: asyncHandler(async (req, res) => {
    const payment = await paymentService.cancelPayment({
      merchant: req.merchant,
      paymentId: req.params.paymentId,
      reason: req.body?.reason,
      actor: actorFrom(req),
    });
    return success(res, payment, { message: 'Payment cancelled' });
  }),

  /** GET /api/v1/payments */
  list: asyncHandler(async (req, res) => {
    const result = await paymentService.listPayments({
      merchantFilter: req.merchantFilter,
      query: req.query,
    });
    return paginated(res, result);
  }),

  /** GET /api/v1/transactions — the merchant's chronological money feed. */
  transactions: asyncHandler(async (req, res) => {
    const result = await paymentService.transactionHistory({
      merchantFilter: req.merchantFilter,
      query: req.query,
    });
    return paginated(res, result);
  }),

  actorFrom,
};
