'use strict';

const { Schema, model } = require('mongoose');
const { CURRENCY } = require('../constants');

/**
 * A merchant is the tenant boundary of the platform. It owns payments,
 * ledger accounts, webhook endpoints and settlements.
 */
const merchantSchema = new Schema(
  {
    merchantId: { type: String, required: true, unique: true },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    email: { type: String, required: true, lowercase: true, trim: true },
    businessType: {
      type: String,
      enum: ['INDIVIDUAL', 'PROPRIETORSHIP', 'PARTNERSHIP', 'PRIVATE_LIMITED', 'LLP'],
      default: 'PRIVATE_LIMITED',
    },
    country: { type: String, required: true, uppercase: true, minlength: 2, maxlength: 2 },
    defaultCurrency: { type: String, enum: Object.values(CURRENCY), default: CURRENCY.INR },

    // API credentials. The public key identifies the merchant; only a hash of
    // the secret is stored, so a database dump does not hand over the ability
    // to sign requests.
    apiKey: { type: String, required: true, unique: true },
    apiSecretHash: { type: String, required: true, select: false },
    // Shared secret for signing *outbound* webhooks to this merchant.
    webhookSecret: { type: String, required: true, select: false },

    status: {
      type: String,
      enum: ['PENDING', 'ACTIVE', 'SUSPENDED', 'TERMINATED'],
      default: 'PENDING',
      index: true,
    },

    /** Per-merchant risk and commercial configuration. */
    riskProfile: {
      // Merchants in high-risk categories get a lower block threshold.
      tier: { type: String, enum: ['LOW', 'MEDIUM', 'HIGH'], default: 'MEDIUM' },
      maxTransactionMinor: { type: Number, default: 50_000_000 },
      allowedCountries: { type: [String], default: [] }, // empty ⇒ no restriction
      blockedCountries: { type: [String], default: [] },
    },

    settlementConfig: {
      // T+N banking days before captured funds become settleable.
      holdHours: { type: Number, default: 24 },
      platformFeeBps: { type: Number, default: 200, min: 0, max: 10000 },
      bankAccountLast4: { type: String, default: null },
      autoSettle: { type: Boolean, default: true },
    },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        delete ret.apiSecretHash;
        delete ret.webhookSecret;
        delete ret.__v;
        return ret;
      },
    },
  },
);

// `merchantId` and `apiKey` already carry unique indexes from their field
// definitions; this compound index serves the console's merchant list view.
merchantSchema.index({ status: 1, createdAt: -1 });

module.exports = model('Merchant', merchantSchema);
