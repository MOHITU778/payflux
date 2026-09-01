'use strict';

const BaseRepository = require('./base.repository');
const { Transaction } = require('../models');

class TransactionRepository extends BaseRepository {
  constructor() { super(Transaction); }

  /**
   * Full-text-ish search over the merchant's transaction feed.
   *
   * Deliberately anchored (`^`) on id fields rather than using an unanchored
   * regex: an unanchored `.*term.*` cannot use an index and degrades into a
   * collection scan as the feed grows.
   */
  search(merchantFilter, { term, type, status, from, to, ...page }) {
    const filter = { ...merchantFilter };
    if (type) filter.type = type;
    if (status) filter.status = status;
    if (from || to) {
      filter.occurredAt = {};
      if (from) filter.occurredAt.$gte = from;
      if (to) filter.occurredAt.$lte = to;
    }
    if (term) {
      const anchored = new RegExp(`^${escapeRegex(term)}`, 'i');
      filter.$or = [{ transactionId: anchored }, { sourceId: anchored }];
    }
    return this.paginate(filter, { ...page, sort: page.sort ?? { occurredAt: -1 } });
  }
}

/** Escape user input before it becomes part of a RegExp — ReDoS protection. */
function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = new TransactionRepository();
module.exports.TransactionRepository = TransactionRepository;
module.exports.escapeRegex = escapeRegex;
