'use strict';

const BaseRepository = require('./base.repository');
const { LedgerAccount, LedgerEntry, Journal } = require('../models');
const { ENTRY_TYPE, NORMAL_BALANCE } = require('../constants');

/**
 * Data access for the double-entry ledger.
 *
 * Three collections move together — accounts (balances), journals (balanced
 * events) and entries (immutable legs) — so they share one repository rather
 * than three that would have to coordinate across a transaction boundary.
 */
class LedgerRepository extends BaseRepository {
  constructor() {
    super(LedgerEntry);
    this.accounts = LedgerAccount;
    this.journals = Journal;
  }

  /**
   * Fetch an account, creating it on first use.
   *
   * `upsert` with `$setOnInsert` makes this safe under concurrency: two
   * requests racing to create the same merchant account produce one document,
   * and the loser simply reads it back. A find-then-create would leave a window
   * for a duplicate-key error.
   */
  async ensureAccount({ code, name, type, currency, merchant = null, isSystem = false }, session) {
    return this.accounts
      .findOneAndUpdate(
        { code, currency },
        {
          $setOnInsert: {
            code, name, type, currency, merchant, isSystem,
            balanceMinor: 0, totalDebitMinor: 0, totalCreditMinor: 0, entrySequence: 0,
          },
        },
        { upsert: true, new: true, session: session ?? null, setDefaultsOnInsert: true },
      )
      .lean();
  }

  findAccount(code, currency, session) {
    return this.accounts.findOne({ code, currency }).session(session ?? null).lean();
  }

  listAccounts(filter = {}) {
    return this.accounts.find(filter).sort({ code: 1 }).lean();
  }

  /**
   * Apply one leg to an account and return the resulting balance.
   *
   * The whole mutation — balance, gross totals and the sequence counter — is a
   * single atomic `findOneAndUpdate`. Returning `new: true` gives us the
   * post-image, which is exactly the `balanceAfterMinor` and `sequence` the
   * immutable entry must record. Reading the balance separately would be a
   * race; this is why the running balance can be trusted.
   *
   * Sign convention: a debit increases an ASSET/EXPENSE account and decreases a
   * LIABILITY/REVENUE one, per the account's normal balance.
   */
  async applyToAccount(accountId, { entryType, amountMinor, accountType }, session) {
    const increasesBalance = NORMAL_BALANCE[accountType] === entryType;
    const delta = increasesBalance ? amountMinor : -amountMinor;

    return this.accounts
      .findOneAndUpdate(
        { _id: accountId },
        {
          $inc: {
            balanceMinor: delta,
            entrySequence: 1,
            ...(entryType === ENTRY_TYPE.DEBIT
              ? { totalDebitMinor: amountMinor }
              : { totalCreditMinor: amountMinor }),
          },
          $set: { lastEntryAt: new Date() },
        },
        { new: true, session: session ?? null },
      )
      .lean();
  }

  createJournal(data, session) {
    return this.journals.create([data], { session: session ?? null }).then(([doc]) => doc.toObject());
  }

  findJournal(journalId) {
    return this.journals.findOne({ journalId }).lean();
  }

  findJournalByIdempotencyKey(idempotencyKey, session) {
    return this.journals.findOne({ idempotencyKey }).session(session ?? null).lean();
  }

  entriesForJournal(journalId) {
    return this.find({ journalId }, { sort: { sequence: 1 } });
  }

  /** Statement view for one account, newest first. */
  statement(accountId, { page = 1, limit = 50 } = {}) {
    return this.paginate({ account: accountId }, { page, limit, sort: { sequence: -1 } });
  }

  entriesForReference(referenceType, referenceId) {
    return this.find({ 'reference.type': referenceType, 'reference.id': referenceId },
      { sort: { postedAt: 1 } });
  }

  /**
   * Recompute an account's balance directly from its entry stream.
   * This is the independent check that makes the cached `balanceMinor`
   * trustworthy — reconciliation compares the two.
   */
  async recomputeBalance(accountId, accountType) {
    const [row] = await this.aggregate([
      { $match: { account: accountId } },
      {
        $group: {
          _id: null,
          debit: { $sum: { $cond: [{ $eq: ['$entryType', ENTRY_TYPE.DEBIT] }, '$amountMinor', 0] } },
          credit: { $sum: { $cond: [{ $eq: ['$entryType', ENTRY_TYPE.CREDIT] }, '$amountMinor', 0] } },
          count: { $sum: 1 },
          maxSequence: { $max: '$sequence' },
        },
      },
    ]);
    if (!row) return { balanceMinor: 0, debit: 0, credit: 0, count: 0, maxSequence: 0 };
    const balanceMinor = NORMAL_BALANCE[accountType] === ENTRY_TYPE.DEBIT
      ? row.debit - row.credit
      : row.credit - row.debit;
    return { ...row, balanceMinor };
  }

  /** Journals whose legs do not sum to zero — should always be empty. */
  findUnbalancedJournals({ from, to }) {
    return this.journals.aggregate([
      { $match: { postedAt: { $gte: from, $lte: to }, status: 'POSTED' } },
      { $match: { $expr: { $ne: ['$totalDebitMinor', '$totalCreditMinor'] } } },
      { $limit: 100 },
    ]);
  }

  /**
   * Global trial balance: total debits vs total credits across every entry in
   * the window. In a correct double-entry system these are always equal.
   */
  async trialBalance({ from, to, currency }) {
    const [row] = await this.aggregate([
      { $match: { postedAt: { $gte: from, $lte: to }, currency } },
      {
        $group: {
          _id: null,
          totalDebitMinor: { $sum: { $cond: [{ $eq: ['$entryType', ENTRY_TYPE.DEBIT] }, '$amountMinor', 0] } },
          totalCreditMinor: { $sum: { $cond: [{ $eq: ['$entryType', ENTRY_TYPE.CREDIT] }, '$amountMinor', 0] } },
          entryCount: { $sum: 1 },
        },
      },
    ]);
    return row ?? { totalDebitMinor: 0, totalCreditMinor: 0, entryCount: 0 };
  }
}

module.exports = new LedgerRepository();
module.exports.LedgerRepository = LedgerRepository;
