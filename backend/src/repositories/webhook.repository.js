'use strict';

const BaseRepository = require('./base.repository');
const { WebhookEndpoint, WebhookDelivery, InboundWebhook } = require('../models');
const { WEBHOOK_DELIVERY_STATUS } = require('../constants');

class WebhookRepository extends BaseRepository {
  constructor() {
    super(WebhookDelivery);
    this.endpoints = WebhookEndpoint;
    this.inbound = InboundWebhook;
  }

  // ── Endpoints ─────────────────────────────────────────────────────────

  createEndpoint(data) {
    return this.endpoints.create(data).then((doc) => doc.toObject());
  }

  findEndpoint(endpointId, opts = {}) {
    let query = this.endpoints.findOne({ endpointId });
    if (opts.withSecret) query = query.select('+secret +previousSecret');
    return query.lean();
  }

  listEndpoints(merchantObjectId) {
    return this.endpoints.find({ merchant: merchantObjectId }).sort({ createdAt: -1 }).lean();
  }

  /**
   * Active endpoints subscribed to an event.
   * An empty `subscribedEvents` array means "everything", so the filter has to
   * match either the explicit subscription or the empty-array wildcard.
   */
  findSubscribers(merchantObjectId, eventType) {
    return this.endpoints
      .find({
        merchant: merchantObjectId,
        isActive: true,
        $or: [{ subscribedEvents: eventType }, { subscribedEvents: { $size: 0 } }],
      })
      .select('+secret')
      .lean();
  }

  /** Reset the failure streak after a successful delivery. */
  markEndpointHealthy(endpointObjectId) {
    return this.endpoints.updateOne(
      { _id: endpointObjectId },
      { $set: { 'health.consecutiveFailures': 0, 'health.lastSuccessAt': new Date() } },
    );
  }

  /**
   * Record a failure and auto-disable the endpoint once it has failed
   * `threshold` times in a row, so a permanently dead URL stops consuming
   * dispatcher throughput.
   */
  markEndpointFailed(endpointObjectId, reason, threshold) {
    return this.endpoints.findOneAndUpdate(
      { _id: endpointObjectId },
      [
        {
          $set: {
            'health.consecutiveFailures': { $add: ['$health.consecutiveFailures', 1] },
            'health.lastFailureAt': '$$NOW',
            'health.lastFailureReason': reason,
            isActive: {
              $cond: [{ $gte: [{ $add: ['$health.consecutiveFailures', 1] }, threshold] }, false, '$isActive'],
            },
            'health.disabledAt': {
              $cond: [{ $gte: [{ $add: ['$health.consecutiveFailures', 1] }, threshold] }, '$$NOW', '$health.disabledAt'],
            },
          },
        },
      ],
      { new: true },
    ).lean();
  }

  updateEndpoint(endpointId, merchantObjectId, update) {
    return this.endpoints
      .findOneAndUpdate({ endpointId, merchant: merchantObjectId }, update, { new: true })
      .lean();
  }

  // ── Deliveries ────────────────────────────────────────────────────────

  /**
   * Create the outbox row for one (event, endpoint) pair.
   *
   * Returns `null` when the unique (eventId, endpoint) index rejects the
   * insert, which means this exact event was already queued for this endpoint.
   * That is the duplicate-prevention guarantee, and it is a normal outcome
   * under producer retries — not an error.
   */
  async createDelivery(data) {
    try {
      const doc = await WebhookDelivery.create(data);
      return doc.toObject();
    } catch (err) {
      if (err.code === 11000) return null;
      throw err;
    }
  }

  findDelivery(deliveryId) {
    return this.findOne({ deliveryId });
  }

  /** Append an attempt and schedule the next one. */
  recordAttempt(deliveryId, attempt, { status, nextAttemptAt, deliveredAt, deadLetteredAt }) {
    return this.updateOne(
      { deliveryId },
      {
        $push: { attempts: { $each: [attempt], $slice: -20 } }, // keep the last 20 attempts
        $inc: { attemptCount: 1 },
        $set: {
          status,
          nextAttemptAt: nextAttemptAt ?? null,
          ...(deliveredAt ? { deliveredAt } : {}),
          ...(deadLetteredAt ? { deadLetteredAt } : {}),
        },
      },
    );
  }

  /**
   * Deliveries whose retry is due.
   * Backed by the { status, nextAttemptAt } compound index; the sweeper runs
   * this every minute so it must stay an index-only range scan.
   */
  findDueForRetry(limit = 200) {
    return this.find(
      {
        status: { $in: [WEBHOOK_DELIVERY_STATUS.PENDING, WEBHOOK_DELIVERY_STATUS.RETRYING] },
        nextAttemptAt: { $lte: new Date() },
      },
      { sort: { nextAttemptAt: 1 }, limit },
    );
  }

  listDeliveries(filter, page) {
    return this.paginate(filter, { ...page, sort: { createdAt: -1 } });
  }

  deadLetterQueue(merchantFilter = {}, page = {}) {
    return this.paginate(
      { ...merchantFilter, status: WEBHOOK_DELIVERY_STATUS.DEAD_LETTERED },
      { ...page, sort: { deadLetteredAt: -1 } },
    );
  }

  async deliveryStats(merchantFilter, { from, to }) {
    return this.aggregate([
      { $match: { ...merchantFilter, createdAt: { $gte: from, $lte: to } } },
      { $group: { _id: '$status', count: { $sum: 1 }, avgAttempts: { $avg: '$attemptCount' } } },
    ]);
  }

  // ── Inbound ───────────────────────────────────────────────────────────

  /**
   * Persist a received provider event.
   * A duplicate (provider, providerEventId) returns `{ duplicate: true }`
   * rather than throwing — the caller answers 200 and does no further work.
   */
  async recordInbound(data) {
    try {
      const doc = await this.inbound.create(data);
      return { duplicate: false, record: doc.toObject() };
    } catch (err) {
      if (err.code === 11000) {
        const existing = await this.inbound
          .findOne({ provider: data.provider, providerEventId: data.providerEventId })
          .lean();
        return { duplicate: true, record: existing };
      }
      throw err;
    }
  }

  markInboundProcessed(id, status, error = null) {
    return this.inbound.updateOne(
      { _id: id },
      { $set: { status, processedAt: new Date(), processingError: error } },
    );
  }

  listInbound(filter, page) {
    const skip = ((page.page ?? 1) - 1) * (page.limit ?? 20);
    return Promise.all([
      this.inbound.find(filter).sort({ createdAt: -1 }).skip(skip).limit(page.limit ?? 20).lean(),
      this.inbound.countDocuments(filter),
    ]).then(([items, total]) => ({ items, total, page: page.page ?? 1, limit: page.limit ?? 20 }));
  }
}

module.exports = new WebhookRepository();
module.exports.WebhookRepository = WebhookRepository;
