'use strict';

const config = require('../config');
const logger = require('../config/logger');
const metrics = require('../config/metrics');
const ids = require('../utils/ids');
const pagination = require('../utils/pagination');
const cryptoUtil = require('../utils/crypto');
const { webhookRetryDelay, WEBHOOK_RETRY_SCHEDULE_MS } = require('../utils/backoff');
const { webhookRepository, merchantRepository } = require('../repositories');
const { WEBHOOK_DELIVERY_STATUS, AUDIT_ACTION } = require('../constants');
const { NotFoundError, BusinessRuleError } = require('../errors');
const auditService = require('./audit.service');
const producers = require('../queues/producers');
const { deadLetter, QUEUE } = require('../queues');

/**
 * Outbound webhook delivery.
 *
 * ── Guarantees offered to merchants ────────────────────────────────────────
 *   • At-least-once delivery with a published retry ladder
 *     (10s → 60s → 5m → 30m → 2h → 6h, then dead-letter).
 *   • Every request is HMAC-SHA256 signed over `${timestamp}.${body}`, so a
 *     receiver can verify both authenticity and freshness.
 *   • A stable `eventId` in the payload, so a receiver can deduplicate. We
 *     promise at-least-once; the receiver makes it effectively-once.
 *
 * ── The outbox pattern ─────────────────────────────────────────────────────
 * `fanout` writes a delivery row per subscribed endpoint *before* any HTTP is
 * attempted. If the process dies mid-dispatch, the row is still there and the
 * retry sweeper finds it. Without the outbox, an event that was only ever held
 * in memory would vanish with the pod.
 *
 * ── Duplicate suppression ──────────────────────────────────────────────────
 * The unique (eventId, endpoint) index means a producer retry cannot create a
 * second delivery for the same event — the insert is rejected and treated as a
 * no-op, not an error.
 */
class WebhookService {
  constructor(deps = {}) {
    this.repository = deps.webhookRepository ?? webhookRepository;
    this.merchants = deps.merchantRepository ?? merchantRepository;
    this.audit = deps.auditService ?? auditService;
    this.producers = deps.producers ?? producers;
    // Injectable so tests can drive delivery without real sockets.
    this.httpClient = deps.httpClient ?? defaultHttpClient;
    this.log = logger.child({ component: 'webhook' });
  }

  // ── Endpoint management ────────────────────────────────────────────────

  /**
   * Register an endpoint. The signing secret is returned exactly once — we
   * store it `select: false` and never echo it again, so a leaked console
   * session cannot harvest existing secrets.
   */
  async createEndpoint({ merchant, url, description, subscribedEvents = [], actor }) {
    if (config.isProduction && !url.startsWith('https://')) {
      throw new BusinessRuleError('Webhook endpoints must use HTTPS', 'INSECURE_WEBHOOK_URL');
    }

    const secret = `whsec_${ids.randomString(40)}`;
    const endpoint = await this.repository.createEndpoint({
      endpointId: ids.webhookEndpointId(),
      merchant: merchant._id,
      url,
      description: description ?? null,
      subscribedEvents,
      secret,
    });

    this.audit.record({
      action: AUDIT_ACTION.WEBHOOK_ENDPOINT_CREATE,
      outcome: 'SUCCESS',
      actor,
      merchant: merchant._id,
      target: { type: 'WebhookEndpoint', id: endpoint.endpointId },
      metadata: { url, subscribedEvents },
    });

    return { ...this.toEndpointView(endpoint), secret };
  }

  listEndpoints(merchant) {
    return this.repository.listEndpoints(merchant._id).then((list) => list.map(this.toEndpointView));
  }

  async updateEndpoint({ merchant, endpointId, update }) {
    const allowed = {};
    for (const field of ['url', 'description', 'subscribedEvents', 'isActive']) {
      if (update[field] !== undefined) allowed[field] = update[field];
    }
    // Re-enabling an endpoint clears its failure streak, otherwise it would be
    // auto-disabled again on the first hiccup.
    if (allowed.isActive === true) {
      allowed['health.consecutiveFailures'] = 0;
      allowed['health.disabledAt'] = null;
    }
    const endpoint = await this.repository.updateEndpoint(endpointId, merchant._id, { $set: allowed });
    if (!endpoint) throw new NotFoundError('Webhook endpoint');
    return this.toEndpointView(endpoint);
  }

  /**
   * Rotate the signing secret, keeping the previous one valid during a grace
   * window so the merchant can deploy the new secret without dropping events.
   */
  async rotateSecret({ merchant, endpointId }) {
    const current = await this.repository.findEndpoint(endpointId, { withSecret: true });
    if (!current || String(current.merchant) !== String(merchant._id)) {
      throw new NotFoundError('Webhook endpoint');
    }
    const secret = `whsec_${ids.randomString(40)}`;
    await this.repository.updateEndpoint(endpointId, merchant._id, {
      $set: { secret, previousSecret: current.secret, secretRotatedAt: new Date() },
    });
    return { endpointId, secret, rotatedAt: new Date() };
  }

  // ── Fan-out ────────────────────────────────────────────────────────────

  /**
   * Create a delivery row for every subscribed endpoint and enqueue the first
   * attempt.
   *
   * @returns {Promise<{created: number, skipped: number}>}
   */
  async fanout({ merchantObjectId, eventType, eventId, data }) {
    const endpoints = await this.repository.findSubscribers(merchantObjectId, eventType);
    if (!endpoints.length) {
      this.log.debug('no subscribers for event', { eventType });
      return { created: 0, skipped: 0 };
    }

    const payload = {
      id: eventId,
      type: eventType,
      createdAt: new Date().toISOString(),
      data,
    };

    let created = 0;
    let skipped = 0;

    for (const endpoint of endpoints) {
      const delivery = await this.repository.createDelivery({
        deliveryId: ids.deliveryId(),
        eventId,
        eventType,
        endpoint: endpoint._id,
        merchant: merchantObjectId,
        url: endpoint.url,
        payload,
        status: WEBHOOK_DELIVERY_STATUS.PENDING,
        maxAttempts: config.webhook.maxAttempts,
        nextAttemptAt: new Date(),
      });

      if (!delivery) {
        // The unique index rejected it: this event was already queued here.
        skipped += 1;
        continue;
      }
      created += 1;
      await this.producers.dispatchWebhook(delivery.deliveryId, { attempt: 1 });
    }

    this.log.info('webhook fanout complete', { eventType, eventId, created, skipped });
    return { created, skipped };
  }

  // ── Delivery ───────────────────────────────────────────────────────────

  /**
   * Perform one HTTP attempt.
   *
   * Retry decisions follow HTTP semantics, not a blanket rule:
   *   2xx      → delivered
   *   410 Gone → the endpoint says stop; dead-letter immediately
   *   4xx      → the request is malformed for this receiver; retrying an
   *              unchanged payload will not help, so dead-letter
   *   5xx / timeout / connection error → transient; retry per the ladder
   *
   * Retrying a 400 forever is the classic mistake — it wastes capacity and
   * hides a real integration bug from the merchant.
   */
  async deliver(deliveryId) {
    const delivery = await this.repository.findDelivery(deliveryId);
    if (!delivery) throw new NotFoundError('Webhook delivery');

    if (delivery.status === WEBHOOK_DELIVERY_STATUS.DELIVERED) {
      this.log.debug('delivery already succeeded, skipping', { deliveryId });
      return { skipped: true };
    }
    if (delivery.status === WEBHOOK_DELIVERY_STATUS.DEAD_LETTERED) {
      return { skipped: true };
    }

    const endpoint = await this.repository.endpoints
      .findById(delivery.endpoint).select('+secret').lean();
    if (!endpoint) {
      await this.repository.recordAttempt(deliveryId, {
        attempt: delivery.attemptCount + 1, error: 'Endpoint no longer exists',
      }, { status: WEBHOOK_DELIVERY_STATUS.DEAD_LETTERED, deadLetteredAt: new Date() });
      return { deadLettered: true };
    }

    const attemptNumber = delivery.attemptCount + 1;
    // Sign the exact bytes we transmit — canonical form, so the receiver's
    // verification over the raw body reproduces our HMAC precisely.
    const body = cryptoUtil.canonicalBody(delivery.payload);
    const { header, timestamp } = cryptoUtil.signPayload(body, endpoint.secret);
    const startedAt = Date.now();

    let response;
    let error = null;
    try {
      response = await this.httpClient({
        url: delivery.url,
        body,
        headers: {
          'content-type': 'application/json',
          [config.webhook.signatureHeader]: header,
          'x-payflux-event-id': delivery.eventId,
          'x-payflux-event-type': delivery.eventType,
          'x-payflux-delivery-id': delivery.deliveryId,
          'x-payflux-attempt': String(attemptNumber),
          'x-payflux-timestamp': String(timestamp),
          'user-agent': 'PayFlux-Webhooks/1.0',
        },
        timeoutMs: config.webhook.timeoutMs,
      });
    } catch (err) {
      error = err.message;
    }

    const durationMs = Date.now() - startedAt;
    const statusCode = response?.statusCode ?? null;
    const attempt = {
      attempt: attemptNumber,
      at: new Date(),
      statusCode,
      durationMs,
      error,
      responseBody: response?.body ? String(response.body).slice(0, 2000) : null,
    };

    // ── Success ──────────────────────────────────────────────────────────
    if (statusCode && statusCode >= 200 && statusCode < 300) {
      await this.repository.recordAttempt(deliveryId, attempt, {
        status: WEBHOOK_DELIVERY_STATUS.DELIVERED,
        deliveredAt: new Date(),
      });
      await this.repository.markEndpointHealthy(delivery.endpoint);
      metrics.webhookDeliveries.inc({ outcome: 'delivered', event: delivery.eventType });
      this.log.info('webhook delivered', { deliveryId, statusCode, attemptNumber, durationMs });
      return { delivered: true, statusCode };
    }

    // ── Permanent failure ────────────────────────────────────────────────
    const permanent = statusCode === 410 || (statusCode >= 400 && statusCode < 500 && statusCode !== 429);
    const exhausted = attemptNumber >= delivery.maxAttempts;

    if (permanent || exhausted) {
      await this.repository.recordAttempt(deliveryId, attempt, {
        status: WEBHOOK_DELIVERY_STATUS.DEAD_LETTERED,
        deadLetteredAt: new Date(),
      });
      await this.repository.markEndpointFailed(
        delivery.endpoint,
        error ?? `HTTP ${statusCode}`,
        config.webhook.maxAttempts,
      );
      await deadLetter({
        queue: QUEUE.WEBHOOK_DISPATCH,
        jobName: 'webhook.deliver',
        data: { deliveryId, eventId: delivery.eventId, url: delivery.url },
        error: error ?? `HTTP ${statusCode}`,
        attemptsMade: attemptNumber,
      });
      metrics.webhookDeliveries.inc({ outcome: 'dead_lettered', event: delivery.eventType });
      this.log.error('webhook dead-lettered', {
        deliveryId, statusCode, error, attemptNumber, reason: permanent ? 'permanent' : 'exhausted',
      });
      return { deadLettered: true, statusCode };
    }

    // ── Transient failure — schedule the next attempt ────────────────────
    const delay = webhookRetryDelay(attemptNumber);
    const nextAttemptAt = new Date(Date.now() + delay);
    await this.repository.recordAttempt(deliveryId, attempt, {
      status: WEBHOOK_DELIVERY_STATUS.RETRYING,
      nextAttemptAt,
    });
    await this.repository.markEndpointFailed(
      delivery.endpoint, error ?? `HTTP ${statusCode}`, config.webhook.maxAttempts,
    );
    await this.producers.dispatchWebhook(deliveryId, { delay, attempt: attemptNumber + 1 });

    metrics.webhookDeliveries.inc({ outcome: 'retrying', event: delivery.eventType });
    this.log.warn('webhook delivery failed, retry scheduled', {
      deliveryId, statusCode, error, attemptNumber, retryInMs: delay,
    });
    return { retrying: true, nextAttemptAt, statusCode };
  }

  /**
   * Replay a dead-lettered delivery as a *new* delivery.
   *
   * A new row rather than a reset of the old one: the failed attempt history is
   * evidence and must survive. The link back is kept in
   * `replayedFromDeliveryId`.
   */
  async replay({ merchant, deliveryId, actor }) {
    const original = await this.repository.findDelivery(deliveryId);
    if (!original) throw new NotFoundError('Webhook delivery');
    if (merchant && String(original.merchant) !== String(merchant._id)) {
      throw new NotFoundError('Webhook delivery');
    }

    const replayId = ids.deliveryId();
    const replay = await this.repository.createDelivery({
      deliveryId: replayId,
      // A fresh event id, because the unique (eventId, endpoint) index would
      // otherwise reject the replay as a duplicate of the original.
      eventId: `${original.eventId}:replay:${Date.now()}`,
      eventType: original.eventType,
      endpoint: original.endpoint,
      merchant: original.merchant,
      url: original.url,
      payload: original.payload,
      status: WEBHOOK_DELIVERY_STATUS.PENDING,
      maxAttempts: config.webhook.maxAttempts,
      nextAttemptAt: new Date(),
      replayedFromDeliveryId: deliveryId,
    });

    await this.producers.dispatchWebhook(replayId, { attempt: 1 });
    this.audit.record({
      action: AUDIT_ACTION.WEBHOOK_REPLAY,
      outcome: 'SUCCESS',
      actor,
      merchant: original.merchant,
      target: { type: 'WebhookDelivery', id: replayId },
      metadata: { replayedFrom: deliveryId },
    });

    this.log.info('webhook delivery replayed', { original: deliveryId, replay: replayId });
    return replay;
  }

  // ── Inbound ────────────────────────────────────────────────────────────

  /**
   * Ingest a webhook from an acquirer.
   *
   * Two independent protections:
   *   • signature verification, over the *raw* body — parsing first and
   *     re-serialising would change the bytes and break the HMAC;
   *   • deduplication on (provider, providerEventId), because upstream
   *     providers are at-least-once too.
   */
  async receiveInbound({ provider, rawBody, signatureHeader, secret, sourceIp, headers }) {
    const verification = cryptoUtil.verifySignature(rawBody, signatureHeader, secret);

    let payload;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new BusinessRuleError('Malformed webhook payload', 'INVALID_WEBHOOK_BODY');
    }

    const providerEventId = payload.id ?? payload.event_id ?? `${provider}:${Date.now()}`;
    const { duplicate, record } = await this.repository.recordInbound({
      provider,
      providerEventId,
      eventType: payload.type ?? payload.event ?? 'unknown',
      signatureValid: verification.valid,
      signatureFailureReason: verification.reason ?? null,
      payload,
      headers,
      sourceIp,
      relatedPaymentId: payload.data?.paymentId ?? null,
      status: verification.valid ? 'RECEIVED' : 'REJECTED',
    });

    if (duplicate) {
      this.log.info('duplicate inbound webhook ignored', { provider, providerEventId });
      return { duplicate: true, accepted: true, record };
    }
    if (!verification.valid) {
      this.log.warn('rejected inbound webhook: bad signature', {
        provider, providerEventId, reason: verification.reason, sourceIp,
      });
      return { duplicate: false, accepted: false, reason: verification.reason, record };
    }

    return { duplicate: false, accepted: true, record };
  }

  // ── Reads ──────────────────────────────────────────────────────────────

  async listDeliveries({ merchantFilter, query }) {
    const { page, limit } = pagination.normalize(query);
    const filter = { ...merchantFilter };
    if (query.status) filter.status = query.status;
    if (query.eventType) filter.eventType = query.eventType;
    return this.repository.listDeliveries(filter, { page, limit });
  }

  deadLetterQueue({ merchantFilter, query }) {
    const { page, limit } = pagination.normalize(query);
    return this.repository.deadLetterQueue(merchantFilter, { page, limit });
  }

  stats(merchantFilter, range) {
    return this.repository.deliveryStats(merchantFilter, range);
  }

  toEndpointView(endpoint) {
    return {
      endpointId: endpoint.endpointId,
      url: endpoint.url,
      description: endpoint.description,
      subscribedEvents: endpoint.subscribedEvents,
      isActive: endpoint.isActive,
      health: endpoint.health,
      retrySchedule: WEBHOOK_RETRY_SCHEDULE_MS,
      createdAt: endpoint.createdAt,
    };
  }
}

/**
 * Minimal HTTP client over Node's global fetch.
 *
 * `AbortController` enforces the timeout: without it a receiver that accepts
 * the connection and never responds would pin a worker slot indefinitely, and
 * a handful of such endpoints would stall the entire dispatch queue.
 */
async function defaultHttpClient({ url, body, headers, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
      redirect: 'manual', // never follow a redirect to an unverified host
    });
    const text = await response.text().catch(() => '');
    return { statusCode: response.status, body: text };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = new WebhookService();
module.exports.WebhookService = WebhookService;
module.exports.defaultHttpClient = defaultHttpClient;
