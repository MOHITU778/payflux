'use strict';

const { Schema, model } = require('mongoose');
const { EVENT } = require('../constants');

/**
 * A merchant-registered destination for outbound event notifications.
 *
 * Each endpoint carries its own signing secret so a merchant can rotate one
 * destination without invalidating the others, and so a compromised staging
 * endpoint cannot forge production events.
 */
const webhookEndpointSchema = new Schema(
  {
    endpointId: { type: String, required: true, unique: true },
    merchant: { type: Schema.Types.ObjectId, ref: 'Merchant', required: true, index: true },

    url: {
      type: String,
      required: true,
      validate: {
        // HTTPS-only in production: an event payload contains transaction
        // metadata and must not cross the network in cleartext.
        validator: (value) => /^https?:\/\/.+/.test(value),
        message: 'Endpoint URL must be a valid http(s) URL',
      },
    },
    description: { type: String, default: null, maxlength: 200 },

    /** Empty array ⇒ subscribe to every event type. */
    subscribedEvents: {
      type: [String],
      default: [],
      validate: {
        validator: (events) => events.every((e) => Object.values(EVENT).includes(e)),
        message: 'Unknown event type in subscription list',
      },
    },

    secret: { type: String, required: true, select: false },
    /** Previous secret, honoured during a rotation grace window. */
    previousSecret: { type: String, default: null, select: false },
    secretRotatedAt: { type: Date, default: null },

    isActive: { type: Boolean, default: true, index: true },

    /**
     * Endpoint health. After `maxAttempts` consecutive failures the endpoint is
     * auto-disabled so a dead URL stops consuming dispatcher capacity; the
     * merchant re-enables it from the console once fixed.
     */
    health: {
      consecutiveFailures: { type: Number, default: 0 },
      lastSuccessAt: { type: Date, default: null },
      lastFailureAt: { type: Date, default: null },
      lastFailureReason: { type: String, default: null },
      disabledAt: { type: Date, default: null },
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_d, ret) { delete ret.secret; delete ret.previousSecret; delete ret.__v; return ret; },
    },
  },
);

webhookEndpointSchema.index({ merchant: 1, isActive: 1 });

module.exports = model('WebhookEndpoint', webhookEndpointSchema);
