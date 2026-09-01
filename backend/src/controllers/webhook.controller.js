'use strict';

const webhookService = require('../services/webhook.service');
const merchantRepository = require('../repositories/merchant.repository');
const asyncHandler = require('../utils/asyncHandler');
const { success, created, paginated } = require('../utils/apiResponse');
const { actorFrom } = require('./payment.controller');
const config = require('../config');
const logger = require('../config/logger');
const { NotFoundError } = require('../errors');

module.exports = {
  /** POST /api/v1/webhooks/endpoints — the secret is returned exactly once. */
  createEndpoint: asyncHandler(async (req, res) => {
    const endpoint = await webhookService.createEndpoint({
      merchant: req.merchant,
      url: req.body.url,
      description: req.body.description,
      subscribedEvents: req.body.subscribedEvents,
      actor: actorFrom(req),
    });
    return created(res, {
      ...endpoint,
      notice: 'Store this secret now — it cannot be retrieved again.',
    });
  }),

  listEndpoints: asyncHandler(async (req, res) => {
    return success(res, await webhookService.listEndpoints(req.merchant));
  }),

  updateEndpoint: asyncHandler(async (req, res) => {
    const endpoint = await webhookService.updateEndpoint({
      merchant: req.merchant,
      endpointId: req.params.endpointId,
      update: req.body,
    });
    return success(res, endpoint);
  }),

  /** POST /api/v1/webhooks/endpoints/:endpointId/rotate-secret */
  rotateSecret: asyncHandler(async (req, res) => {
    const result = await webhookService.rotateSecret({
      merchant: req.merchant,
      endpointId: req.params.endpointId,
    });
    return success(res, {
      ...result,
      notice: 'The previous secret stays valid briefly so you can deploy without dropping events.',
    });
  }),

  /** GET /api/v1/webhooks/deliveries */
  listDeliveries: asyncHandler(async (req, res) => {
    const result = await webhookService.listDeliveries({
      merchantFilter: req.merchantFilter,
      query: req.query,
    });
    return paginated(res, result);
  }),

  /** GET /api/v1/webhooks/dead-letter */
  deadLetterQueue: asyncHandler(async (req, res) => {
    const result = await webhookService.deadLetterQueue({
      merchantFilter: req.merchantFilter,
      query: req.query,
    });
    return paginated(res, result);
  }),

  /** POST /api/v1/webhooks/deliveries/:deliveryId/replay */
  replay: asyncHandler(async (req, res) => {
    const replay = await webhookService.replay({
      merchant: req.merchant,
      deliveryId: req.params.deliveryId,
      actor: actorFrom(req),
    });
    return created(res, { deliveryId: replay.deliveryId, status: replay.status });
  }),

  /**
   * POST /api/v1/webhooks/inbound/:provider
   *
   * Receives events from an acquirer. Three properties matter:
   *   • the *raw* body is verified, not a re-serialised parse — re-serialising
   *     changes the bytes and would break the HMAC;
   *   • duplicates are acknowledged with 200 and dropped, because upstream
   *     providers retry;
   *   • processing happens asynchronously, so a slow handler cannot cause the
   *     provider to time out and retry unnecessarily.
   */
  receiveInbound: asyncHandler(async (req, res) => {
    const { provider } = req.params;
    const merchantId = req.get('x-payflux-merchant-id');

    // The verifying secret is the merchant's inbound webhook secret.
    const merchant = merchantId
      ? await merchantRepository.findByMerchantId(merchantId, { select: '+webhookSecret' })
      : null;
    if (!merchant) throw new NotFoundError('Merchant');

    const result = await webhookService.receiveInbound({
      provider,
      rawBody: req.rawBody?.toString('utf8') ?? JSON.stringify(req.body),
      signatureHeader: req.get(config.webhook.signatureHeader),
      secret: merchant.webhookSecret,
      sourceIp: req.ip,
      headers: { 'user-agent': req.get('user-agent') },
    });

    if (!result.accepted) {
      // 401 tells a legitimate sender their signature is wrong. A retry with
      // the same bad signature will fail identically, which is correct.
      logger.warn('inbound webhook rejected', { provider, reason: result.reason });
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_SIGNATURE', message: result.reason },
      });
    }

    // Always 200 on an accepted event — including duplicates — so the provider
    // stops retrying.
    return success(res, {
      received: true,
      duplicate: result.duplicate,
      eventId: result.record?.providerEventId,
    });
  }),
};
