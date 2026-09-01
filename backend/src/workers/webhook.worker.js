'use strict';

const logger = require('../config/logger');
const webhookService = require('../services/webhook.service');

/**
 * Webhook dispatch worker.
 *
 * BullMQ's own retry is disabled for this queue (`attempts: 1`). Retries are
 * driven by `WebhookService.deliver`, which schedules the next attempt on our
 * *published* ladder and persists the state on the delivery row. Two competing
 * retry mechanisms would double-send, and merchants could not reason about when
 * the next attempt is due.
 *
 * A job that throws here therefore means the dispatcher itself failed (Redis,
 * Mongo), not that the merchant's endpoint failed — those are already handled
 * inside `deliver`.
 */

const log = logger.child({ component: 'worker:webhook' });

async function process(job) {
  if (job.name === 'webhook.fanout') {
    const { eventType, eventId, merchantObjectId, data } = job.data;
    return webhookService.fanout({ merchantObjectId, eventType, eventId, data });
  }

  const { deliveryId, attempt } = job.data;
  const result = await webhookService.deliver(deliveryId);
  log.debug('dispatch attempt complete', { deliveryId, attempt, result });
  return result;
}

module.exports = { process };
