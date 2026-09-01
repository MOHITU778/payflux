'use strict';

const { ledgerRepository } = require('../repositories');
const database = require('../config/database');
const logger = require('../config/logger');
const metrics = require('../config/metrics');
const ids = require('../utils/ids');
const money = require('../utils/money');
const requestContext = require('../utils/requestContext');
const { ENTRY_TYPE, ACCOUNT_TYPE, SYSTEM_ACCOUNT } = require('../constants');
const { BusinessRuleError } = require('../errors');

/**
 * Double-entry ledger.
 *
 * ── Why double-entry ───────────────────────────────────────────────────────
 * A single `balance` column cannot answer "why is this number what it is?",
 * and it cannot be audited. Double-entry records every movement of value as a
 * balanced pair: value always leaves one account and arrives in another, and
 * the sum of all debits equals the sum of all credits at every instant. That
 * invariant is checkable, which is what makes the books provable rather than
 * merely plausible.
 *
 * ── Chart of accounts ──────────────────────────────────────────────────────
 *   gateway_clearing         ASSET      funds held at the acquirer
 *   merchant_payable:<id>    LIABILITY  what we owe a specific merchant
 *   platform_revenue         REVENUE    our processing fee
 *   payment_reversals        EXPENSE    value returned to customers
 *
 * ── Worked example: a ₹1,000.00 card capture at a 2% fee ──────────────────
 *   DEBIT   gateway_clearing        100000   (asset ↑ — we now hold the money)
 *   CREDIT  merchant_payable:mrch_x  98000   (liability ↑ — we owe the merchant)
 *   CREDIT  platform_revenue          2000   (revenue ↑ — our fee)
 *   ───────────────────────────────────────
 *   debits 100000 = credits 100000 ✓
 *
 * ── Idempotency ────────────────────────────────────────────────────────────
 * Every journal carries a deterministic key derived from (eventType,
 * referenceId) with a unique index behind it. A queue that delivers the same
 * "payment succeeded" job twice therefore posts the journal exactly once — the
 * second attempt hits the index and returns the existing journal. This is what
 * makes the ledger safe under at-least-once delivery.
 */
class LedgerService {
  constructor({ repository } = {}) {
    this.repository = repository ?? ledgerRepository;
    this.log = logger.child({ component: 'ledger' });
  }

  // ── Account helpers ────────────────────────────────────────────────────

  /** Per-merchant liability account: the running amount we owe this merchant. */
  merchantPayableAccount(merchant, currency) {
    return {
      code: `merchant_payable:${merchant.merchantId}`,
      name: `Payable to ${merchant.name}`,
      type: ACCOUNT_TYPE.LIABILITY,
      currency,
      merchant: merchant._id,
      isSystem: false,
    };
  }

  systemAccount(code, currency) {
    const definitions = {
      [SYSTEM_ACCOUNT.GATEWAY_CLEARING]: { name: 'Gateway Clearing', type: ACCOUNT_TYPE.ASSET },
      [SYSTEM_ACCOUNT.PLATFORM_REVENUE]: { name: 'Platform Revenue', type: ACCOUNT_TYPE.REVENUE },
      [SYSTEM_ACCOUNT.PAYMENT_REVERSALS]: { name: 'Payment Reversals', type: ACCOUNT_TYPE.EXPENSE },
    };
    const definition = definitions[code];
    if (!definition) throw new BusinessRuleError(`Unknown system account: ${code}`);
    return { code, ...definition, currency, merchant: null, isSystem: true };
  }

  // ── Core posting primitive ─────────────────────────────────────────────

  /**
   * Post a balanced journal.
   *
   * @param {object} params
   * @param {string} params.eventType        'payment.capture', 'refund.settle', …
   * @param {object} params.merchant         Merchant document (may be null for platform entries).
   * @param {string} params.currency
   * @param {Array<{account: object, entryType: string, amountMinor: number, description?: string}>} params.legs
   * @param {{type: string, id: string}} params.reference
   * @param {string} params.idempotencyKey   Deterministic; the uniqueness guarantee.
   * @returns {Promise<{journal: object, entries: object[], replayed: boolean}>}
   */
  async postJournal({ eventType, merchant, currency, legs, reference, description, idempotencyKey }) {
    // ── Guard 1: the accounting identity. Checked before any write, so an
    //    unbalanced journal can never touch an account balance. ───────────
    const totalDebit = money.sum(
      legs.filter((leg) => leg.entryType === ENTRY_TYPE.DEBIT).map((leg) => leg.amountMinor),
    );
    const totalCredit = money.sum(
      legs.filter((leg) => leg.entryType === ENTRY_TYPE.CREDIT).map((leg) => leg.amountMinor),
    );

    if (totalDebit !== totalCredit) {
      metrics.ledgerImbalance.inc();
      this.log.error('rejected unbalanced journal', { eventType, totalDebit, totalCredit, reference });
      throw new BusinessRuleError(
        `Unbalanced journal: debits ${totalDebit} ≠ credits ${totalCredit}`,
        'LEDGER_IMBALANCE',
        { totalDebit, totalCredit, eventType },
      );
    }
    if (legs.length < 2) {
      throw new BusinessRuleError('A journal requires at least two entries', 'LEDGER_INCOMPLETE');
    }

    // ── Guard 2: idempotent replay. Cheaper than waiting for the unique
    //    index to reject the insert, and returns the original journal. ────
    const existing = await this.repository.findJournalByIdempotencyKey(idempotencyKey);
    if (existing) {
      this.log.info('journal already posted, replaying', { idempotencyKey, journalId: existing.journalId });
      return {
        journal: existing,
        entries: await this.repository.entriesForJournal(existing.journalId),
        replayed: true,
      };
    }

    const journalId = ids.journalId();
    const correlationId = requestContext.get('correlationId') ?? null;

    /** The actual writes, factored out so they can run with or without a session. */
    const write = async (session) => {
      const entries = [];

      for (const leg of legs) {
        // Create-or-fetch the account, then apply the leg atomically. The
        // post-image gives us the authoritative balance and sequence, which
        // is why `balanceAfterMinor` can be trusted as a statement line.
        const account = await this.repository.ensureAccount(leg.account, session);
        const updated = await this.repository.applyToAccount(
          account._id,
          { entryType: leg.entryType, amountMinor: leg.amountMinor, accountType: account.type },
          session,
        );

        entries.push({
          entryId: ids.ledgerEntryId(),
          journalId,
          account: account._id,
          accountCode: account.code,
          entryType: leg.entryType,
          amountMinor: leg.amountMinor,
          currency,
          balanceAfterMinor: updated.balanceMinor,
          sequence: updated.entrySequence,
          merchant: account.merchant ?? null,
          reference,
          description: leg.description ?? description ?? null,
          postedAt: new Date(),
        });
      }

      await this.repository.insertMany(entries, { session });

      const journal = await this.repository.createJournal(
        {
          journalId,
          eventType,
          merchant: merchant?._id ?? null,
          currency,
          totalDebitMinor: totalDebit,
          totalCreditMinor: totalCredit,
          entryCount: entries.length,
          status: 'POSTED',
          reference,
          idempotencyKey,
          description: description ?? null,
          correlationId,
        },
        session,
      );

      return { journal, entries, replayed: false };
    };

    // Multi-document transactions need a replica set. In a standalone dev
    // container we still post correctly: the deterministic journal key stops
    // duplicates, and reconciliation detects any partial write.
    const result = database.supportsTransactions()
      ? await this.repository.withTransaction(write)
      : await write(null);

    this.log.info('journal posted', {
      journalId, eventType, totalDebit, currency, reference: reference.id,
    });
    return result;
  }

  // ── Business events ────────────────────────────────────────────────────

  /**
   * A successful capture. Funds arrive in clearing; we owe the merchant the
   * net and recognise the fee as revenue.
   */
  async recordPaymentCapture({ payment, merchant }) {
    const { amountMinor, feeMinor, currency, paymentId } = payment;
    const netMinor = amountMinor - feeMinor;

    const legs = [
      {
        account: this.systemAccount(SYSTEM_ACCOUNT.GATEWAY_CLEARING, currency),
        entryType: ENTRY_TYPE.DEBIT,
        amountMinor,
        description: `Capture ${paymentId}`,
      },
      {
        account: this.merchantPayableAccount(merchant, currency),
        entryType: ENTRY_TYPE.CREDIT,
        amountMinor: netMinor,
        description: `Net proceeds ${paymentId}`,
      },
    ];

    // Only post a fee leg when there is a fee — a zero-amount entry is
    // rejected by the entry schema, and a zero row carries no information.
    if (feeMinor > 0) {
      legs.push({
        account: this.systemAccount(SYSTEM_ACCOUNT.PLATFORM_REVENUE, currency),
        entryType: ENTRY_TYPE.CREDIT,
        amountMinor: feeMinor,
        description: `Processing fee ${paymentId}`,
      });
    }

    return this.postJournal({
      eventType: 'payment.capture',
      merchant,
      currency,
      legs,
      reference: { type: 'Payment', id: paymentId },
      description: `Payment capture ${paymentId}`,
      idempotencyKey: `payment.capture:${paymentId}`,
    });
  }

  /**
   * A settled refund. We owe the merchant less, and value leaves clearing.
   * The processing fee is not returned, which mirrors industry practice and
   * keeps `platform_revenue` untouched.
   */
  async recordRefund({ refund, merchant }) {
    const { amountMinor, currency, refundId, paymentId } = refund;

    return this.postJournal({
      eventType: 'refund.settle',
      merchant,
      currency,
      legs: [
        {
          account: this.merchantPayableAccount(merchant, currency),
          entryType: ENTRY_TYPE.DEBIT,
          amountMinor,
          description: `Refund ${refundId} against ${paymentId}`,
        },
        {
          account: this.systemAccount(SYSTEM_ACCOUNT.GATEWAY_CLEARING, currency),
          entryType: ENTRY_TYPE.CREDIT,
          amountMinor,
          description: `Refund payout ${refundId}`,
        },
      ],
      reference: { type: 'Refund', id: refundId },
      description: `Refund ${refundId}`,
      idempotencyKey: `refund.settle:${refundId}`,
    });
  }

  /**
   * A payout. The liability to the merchant is discharged and the money
   * physically leaves our clearing account for their bank.
   */
  async recordSettlement({ settlement, merchant }) {
    const { netAmountMinor, currency, settlementId } = settlement;

    return this.postJournal({
      eventType: 'settlement.payout',
      merchant,
      currency,
      legs: [
        {
          account: this.merchantPayableAccount(merchant, currency),
          entryType: ENTRY_TYPE.DEBIT,
          amountMinor: netAmountMinor,
          description: `Settlement ${settlementId}`,
        },
        {
          account: this.systemAccount(SYSTEM_ACCOUNT.GATEWAY_CLEARING, currency),
          entryType: ENTRY_TYPE.CREDIT,
          amountMinor: netAmountMinor,
          description: `Bank payout ${settlementId}`,
        },
      ],
      reference: { type: 'Settlement', id: settlementId },
      description: `Settlement payout ${settlementId}`,
      idempotencyKey: `settlement.payout:${settlementId}`,
    });
  }

  /**
   * Reverse a posted journal by posting its mirror image.
   *
   * History is never edited — an auditor must be able to see that a mistake
   * was made *and* corrected. The reversal is linked in both directions.
   */
  async reverseJournal(journalId, reason) {
    const original = await this.repository.findJournal(journalId);
    if (!original) throw new BusinessRuleError(`Journal ${journalId} not found`, 'JOURNAL_NOT_FOUND');
    if (original.status === 'REVERSED') {
      throw new BusinessRuleError(`Journal ${journalId} is already reversed`, 'ALREADY_REVERSED');
    }

    const entries = await this.repository.entriesForJournal(journalId);
    const accounts = await this.repository.listAccounts({
      _id: { $in: entries.map((entry) => entry.account) },
    });
    const byId = new Map(accounts.map((account) => [String(account._id), account]));

    const legs = entries.map((entry) => {
      const account = byId.get(String(entry.account));
      return {
        account: {
          code: account.code, name: account.name, type: account.type,
          currency: account.currency, merchant: account.merchant, isSystem: account.isSystem,
        },
        // Flip every leg: debits become credits and vice versa.
        entryType: entry.entryType === ENTRY_TYPE.DEBIT ? ENTRY_TYPE.CREDIT : ENTRY_TYPE.DEBIT,
        amountMinor: entry.amountMinor,
        description: `Reversal of ${entry.entryId}`,
      };
    });

    const result = await this.postJournal({
      eventType: `${original.eventType}.reversal`,
      merchant: original.merchant ? { _id: original.merchant } : null,
      currency: original.currency,
      legs,
      reference: original.reference,
      description: `Reversal of ${journalId}: ${reason}`,
      idempotencyKey: `reversal:${journalId}`,
    });

    await this.repository.journals.updateOne(
      { journalId },
      { $set: { status: 'REVERSED', reversedByJournalId: result.journal.journalId } },
    );
    await this.repository.journals.updateOne(
      { journalId: result.journal.journalId },
      { $set: { reversesJournalId: journalId } },
    );

    this.log.warn('journal reversed', { journalId, reversalId: result.journal.journalId, reason });
    return result;
  }

  // ── Reads ──────────────────────────────────────────────────────────────

  async merchantBalance(merchant, currency) {
    const code = `merchant_payable:${merchant.merchantId}`;
    const account = await this.repository.findAccount(code, currency);
    if (!account) return { code, currency, balanceMinor: 0, formatted: money.toMajorString(0, currency) };
    return {
      code,
      currency,
      balanceMinor: account.balanceMinor,
      totalCreditMinor: account.totalCreditMinor,
      totalDebitMinor: account.totalDebitMinor,
      formatted: money.toMajorString(account.balanceMinor, currency),
      lastEntryAt: account.lastEntryAt,
    };
  }

  async statement(accountCode, currency, page) {
    const account = await this.repository.findAccount(accountCode, currency);
    if (!account) throw new BusinessRuleError(`Account ${accountCode} not found`, 'ACCOUNT_NOT_FOUND');
    const result = await this.repository.statement(account._id, page);
    return { account, ...result };
  }

  entriesForReference(type, id) {
    return this.repository.entriesForReference(type, id);
  }
}

module.exports = new LedgerService();
module.exports.LedgerService = LedgerService;
