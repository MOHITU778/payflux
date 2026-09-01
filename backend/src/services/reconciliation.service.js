'use strict';

const logger = require('../config/logger');
const ids = require('../utils/ids');
const { ledgerRepository } = require('../repositories');
const { Reconciliation } = require('../models');
const { ENTRY_TYPE } = require('../constants');

/**
 * Ledger reconciliation.
 *
 * A double-entry ledger is only as good as the checks run against it. This
 * service recomputes the books from the immutable entry stream and reports
 * every way reality could have diverged from the cached view:
 *
 *   BALANCE_DRIFT      account.balanceMinor ≠ Σ(entries). Means an `$inc`
 *                      landed without its entry, or vice versa.
 *   UNBALANCED_JOURNAL debits ≠ credits within one journal. Should be
 *                      impossible — `postJournal` rejects these before writing —
 *                      so a hit here means data was modified out of band.
 *   SEQUENCE_GAP       an account's entry sequence skips a number, indicating a
 *                      partial write on a deployment without transactions.
 *
 * The run **reports**; it never silently "fixes" a discrepancy. Auto-correcting
 * money is how a bug becomes a cover-up — a human decides, and the correction
 * is posted as a visible reversing journal.
 */
class ReconciliationService {
  constructor(deps = {}) {
    this.ledger = deps.ledgerRepository ?? ledgerRepository;
    this.model = deps.model ?? Reconciliation;
    this.log = logger.child({ component: 'reconciliation' });
  }

  /**
   * Run a reconciliation pass.
   * @param {object} params
   * @param {string} [params.currency='INR']
   * @param {Date}   [params.from]  Defaults to the last 24 hours.
   * @returns {Promise<object>} the persisted report
   */
  async run({ currency = 'INR', from, to = new Date(), triggeredBy = 'scheduler' } = {}) {
    const startedAt = Date.now();
    const periodStart = from ?? new Date(to.getTime() - 86400e3);
    const runId = `recon_${ids.randomString(16)}`;
    const discrepancies = [];

    // ── Check 1: the global trial balance ────────────────────────────────
    const trial = await this.ledger.trialBalance({ from: periodStart, to, currency });
    const imbalanceMinor = trial.totalDebitMinor - trial.totalCreditMinor;

    // ── Check 2: every account's cached balance vs its entry stream ──────
    const accounts = await this.ledger.listAccounts({ currency });
    for (const account of accounts) {
      const recomputed = await this.ledger.recomputeBalance(account._id, account.type);

      if (recomputed.balanceMinor !== account.balanceMinor) {
        discrepancies.push({
          kind: 'BALANCE_DRIFT',
          accountCode: account.code,
          expectedMinor: recomputed.balanceMinor,
          actualMinor: account.balanceMinor,
          deltaMinor: account.balanceMinor - recomputed.balanceMinor,
          detail: 'Cached account balance disagrees with the sum of its entries',
        });
      }

      // The sequence counter must equal the highest entry sequence. A gap
      // means an account was incremented without its entry being written.
      if (recomputed.count > 0 && recomputed.maxSequence !== recomputed.count) {
        discrepancies.push({
          kind: 'SEQUENCE_GAP',
          accountCode: account.code,
          expectedMinor: recomputed.count,
          actualMinor: recomputed.maxSequence,
          detail: `Account has ${recomputed.count} entries but a max sequence of ${recomputed.maxSequence}`,
        });
      }
    }

    // ── Check 3: internally unbalanced journals ──────────────────────────
    const unbalanced = await this.ledger.findUnbalancedJournals({ from: periodStart, to });
    for (const journal of unbalanced) {
      discrepancies.push({
        kind: 'UNBALANCED_JOURNAL',
        journalId: journal.journalId,
        expectedMinor: journal.totalDebitMinor,
        actualMinor: journal.totalCreditMinor,
        deltaMinor: journal.totalDebitMinor - journal.totalCreditMinor,
        detail: 'Journal debits do not equal credits',
      });
    }

    const status = discrepancies.length === 0 && imbalanceMinor === 0
      ? 'BALANCED'
      : 'DISCREPANCY_FOUND';

    const report = await this.model.create({
      runId,
      scope: 'GLOBAL',
      currency,
      periodStart,
      periodEnd: to,
      accountsChecked: accounts.length,
      journalsChecked: unbalanced.length,
      entriesChecked: trial.entryCount,
      totalDebitMinor: trial.totalDebitMinor,
      totalCreditMinor: trial.totalCreditMinor,
      imbalanceMinor,
      status,
      discrepancies,
      durationMs: Date.now() - startedAt,
      triggeredBy,
    });

    const level = status === 'BALANCED' ? 'info' : 'error';
    this.log[level]('reconciliation complete', {
      runId, status, imbalanceMinor, discrepancies: discrepancies.length,
      accountsChecked: accounts.length, durationMs: Date.now() - startedAt,
    });

    return report.toObject();
  }

  list({ page = 1, limit = 20 } = {}) {
    return Promise.all([
      this.model.find().sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      this.model.countDocuments(),
    ]).then(([items, total]) => ({ items, total, page, limit }));
  }

  latest() {
    return this.model.findOne().sort({ createdAt: -1 }).lean();
  }

  /** Trial balance for an arbitrary window — the finance team's export. */
  async trialBalance({ currency = 'INR', from, to = new Date() }) {
    const periodStart = from ?? new Date(to.getTime() - 30 * 86400e3);
    const [totals, accounts] = await Promise.all([
      this.ledger.trialBalance({ from: periodStart, to, currency }),
      this.ledger.listAccounts({ currency }),
    ]);
    return {
      currency,
      periodStart,
      periodEnd: to,
      ...totals,
      balanced: totals.totalDebitMinor === totals.totalCreditMinor,
      accounts: accounts.map((account) => ({
        code: account.code,
        name: account.name,
        type: account.type,
        balanceMinor: account.balanceMinor,
        totalDebitMinor: account.totalDebitMinor,
        totalCreditMinor: account.totalCreditMinor,
        normalBalance: account.type,
        entryCount: account.entrySequence,
      })),
      // Exposed so a reader can confirm which side each account sits on.
      convention: { DEBIT: ENTRY_TYPE.DEBIT, CREDIT: ENTRY_TYPE.CREDIT },
    };
  }
}

module.exports = new ReconciliationService();
module.exports.ReconciliationService = ReconciliationService;
