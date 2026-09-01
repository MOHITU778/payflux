'use strict';

const logger = require('../config/logger');
const settlementService = require('../services/settlement.service');

/** Settlement worker: builds batches and instructs payouts. */
const log = logger.child({ component: 'worker:settlement' });

async function process(job) {
  switch (job.name) {
    case 'settlement.build': {
      const { merchantId, currency } = job.data;
      const settlement = await settlementService.buildBatch({ merchantId, currency });
      if (!settlement) return { built: false, reason: 'nothing eligible' };
      log.info('batch built', {
        settlementId: settlement.settlementId, netAmountMinor: settlement.netAmountMinor,
      });
      return { built: true, settlementId: settlement.settlementId };
    }

    case 'settlement.execute': {
      const settlement = await settlementService.execute(job.data.settlementId);
      return { status: settlement.status, settlementId: settlement.settlementId };
    }

    default:
      throw new Error(`Unknown settlement job: ${job.name}`);
  }
}

module.exports = { process };
