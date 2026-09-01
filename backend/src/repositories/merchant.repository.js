'use strict';

const BaseRepository = require('./base.repository');
const { Merchant } = require('../models');

class MerchantRepository extends BaseRepository {
  constructor() { super(Merchant); }

  findByMerchantId(merchantId, opts = {}) {
    return this.findOne({ merchantId }, opts);
  }

  /** Used by API-key authentication; pulls the normally hidden secret hash. */
  findByApiKeyWithSecret(apiKey) {
    return this.findOne({ apiKey, status: 'ACTIVE' }, { select: '+apiSecretHash +webhookSecret' });
  }

  findWithWebhookSecret(merchantObjectId) {
    return this.findOne({ _id: merchantObjectId }, { select: '+webhookSecret' });
  }

  /** Merchants eligible for the settlement sweep. */
  findAutoSettleable() {
    return this.find({ status: 'ACTIVE', 'settlementConfig.autoSettle': true });
  }
}

module.exports = new MerchantRepository();
module.exports.MerchantRepository = MerchantRepository;
