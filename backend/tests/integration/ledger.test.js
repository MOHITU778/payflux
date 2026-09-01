'use strict';

const mongoose = require('mongoose');
const infra = require('../helpers/infra');

/**
 * Double-entry ledger integration tests.
 *
 * The invariant being defended: for every posted journal, and across the whole
 * book, total debits equal total credits. These run against real MongoDB
 * because the guarantee depends on the unique index behind the journal
 * idempotency key and on atomic `$inc` semantics.
 */

let database;
let redis;
let models;
let ledgerService;
let reconciliationService;
let ids;
let available = false;
let merchant;

beforeAll(async () => {
  available = await infra.infraAvailable();
  if (!available) return;

  database = require('../../src/config/database');
  redis = require('../../src/config/redis');
  models = require('../../src/models');
  ledgerService = require('../../src/services/ledger.service');
  reconciliationService = require('../../src/services/reconciliation.service');
  ids = require('../../src/utils/ids');

  await database.connect();
  await redis.connect();
  await Promise.all([
    models.LedgerEntry, models.LedgerAccount, models.Journal, models.Merchant, models.Reconciliation,
  ].map((m) => m.collection.deleteMany({}).catch(() => {})));

  merchant = await models.Merchant.create({
    merchantId: ids.merchantId(),
    name: 'Ledger Test Co',
    email: 'ledger@test.local',
    country: 'IN',
    apiKey: ids.apiKey(),
    apiSecretHash: 'scrypt$16384$00$00',
    webhookSecret: 'whsec_test',
    status: 'ACTIVE',
  });
});

afterAll(async () => {
  if (!available) return;
  await database.disconnect().catch(() => {});
  await redis.disconnect().catch(() => {});
  await mongoose.disconnect().catch(() => {});
});

const guard = () => available;

const makePayment = (amountMinor, feeMinor) => ({
  paymentId: ids.paymentId(), amountMinor, feeMinor, currency: 'INR',
});

describe('journal posting', () => {
  it('posts a balanced capture: debit clearing, credit merchant + revenue', async () => {
    if (!guard()) return;
    const payment = makePayment(100000, 2000);
    const { journal, entries } = await ledgerService.recordPaymentCapture({ payment, merchant });

    expect(journal.totalDebitMinor).toBe(journal.totalCreditMinor);
    expect(journal.totalDebitMinor).toBe(100000);
    expect(entries).toHaveLength(3);

    const debits = entries.filter((e) => e.entryType === 'DEBIT');
    const credits = entries.filter((e) => e.entryType === 'CREDIT');
    expect(debits).toHaveLength(1);
    expect(debits[0].accountCode).toBe('gateway_clearing');
    expect(debits[0].amountMinor).toBe(100000);
    // Merchant gets the net, the platform keeps the fee.
    expect(credits.find((e) => e.accountCode.startsWith('merchant_payable')).amountMinor).toBe(98000);
    expect(credits.find((e) => e.accountCode === 'platform_revenue').amountMinor).toBe(2000);
  });

  it('omits a zero-value fee leg rather than posting an empty entry', async () => {
    if (!guard()) return;
    const { entries } = await ledgerService.recordPaymentCapture({
      payment: makePayment(50000, 0), merchant,
    });
    expect(entries).toHaveLength(2);
    expect(entries.some((e) => e.accountCode === 'platform_revenue')).toBe(false);
  });

  it('is idempotent — a redelivered job returns the original journal', async () => {
    if (!guard()) return;
    const payment = makePayment(75000, 1500);
    const first = await ledgerService.recordPaymentCapture({ payment, merchant });
    const second = await ledgerService.recordPaymentCapture({ payment, merchant });

    expect(second.replayed).toBe(true);
    expect(second.journal.journalId).toBe(first.journal.journalId);
    // Crucially, no second set of entries was written.
    expect(await models.LedgerEntry.countDocuments({ 'reference.id': payment.paymentId })).toBe(3);
  });

  it('survives a concurrent double-delivery without double-posting', async () => {
    if (!guard()) return;
    const payment = makePayment(60000, 1200);
    // Two workers processing the same job at the same instant.
    await Promise.allSettled([
      ledgerService.recordPaymentCapture({ payment, merchant }),
      ledgerService.recordPaymentCapture({ payment, merchant }),
    ]);
    const journals = await models.Journal.countDocuments({ 'reference.id': payment.paymentId });
    expect(journals).toBe(1);
  });

  it('rejects an unbalanced journal before touching any balance', async () => {
    if (!guard()) return;
    const { ENTRY_TYPE, ACCOUNT_TYPE } = require('../../src/constants');
    const before = await models.LedgerAccount.findOne({ code: 'gateway_clearing' }).lean();

    await expect(ledgerService.postJournal({
      eventType: 'test.unbalanced',
      merchant,
      currency: 'INR',
      legs: [
        { account: { code: 'gateway_clearing', name: 'GC', type: ACCOUNT_TYPE.ASSET, currency: 'INR' },
          entryType: ENTRY_TYPE.DEBIT, amountMinor: 1000 },
        { account: { code: 'platform_revenue', name: 'PR', type: ACCOUNT_TYPE.REVENUE, currency: 'INR' },
          entryType: ENTRY_TYPE.CREDIT, amountMinor: 999 },
      ],
      reference: { type: 'Payment', id: 'pay_unbalanced' },
      idempotencyKey: `test.unbalanced-${Date.now()}`,
    })).rejects.toThrow(/Unbalanced journal/);

    const after = await models.LedgerAccount.findOne({ code: 'gateway_clearing' }).lean();
    // The guard runs before any write, so no balance moved.
    expect(after.balanceMinor).toBe(before.balanceMinor);
  });

  it('records the running balance and a gapless sequence on each entry', async () => {
    if (!guard()) return;
    const account = await models.LedgerAccount.findOne({ code: 'gateway_clearing' }).lean();
    const entries = await models.LedgerEntry.find({ account: account._id })
      .sort({ sequence: 1 }).lean();

    const sequences = entries.map((e) => e.sequence);
    expect(sequences).toEqual([...Array(entries.length).keys()].map((i) => i + 1));

    // Replaying the entries must reproduce the cached balance exactly.
    let running = 0;
    for (const entry of entries) {
      running += entry.entryType === 'DEBIT' ? entry.amountMinor : -entry.amountMinor;
      expect(entry.balanceAfterMinor).toBe(running);
    }
    expect(running).toBe(account.balanceMinor);
  });
});

describe('refund and settlement postings', () => {
  it('reduces the merchant payable when a refund settles', async () => {
    if (!guard()) return;
    const payment = makePayment(200000, 4000);
    await ledgerService.recordPaymentCapture({ payment, merchant });
    const before = await ledgerService.merchantBalance(merchant, 'INR');

    const refund = {
      refundId: ids.refundId(), paymentId: payment.paymentId, amountMinor: 50000, currency: 'INR',
    };
    const { journal } = await ledgerService.recordRefund({ refund, merchant });
    expect(journal.totalDebitMinor).toBe(journal.totalCreditMinor);

    const after = await ledgerService.merchantBalance(merchant, 'INR');
    expect(after.balanceMinor).toBe(before.balanceMinor - 50000);
  });

  it('discharges the liability when a settlement pays out', async () => {
    if (!guard()) return;
    const before = await ledgerService.merchantBalance(merchant, 'INR');
    const settlement = {
      settlementId: ids.settlementId(), netAmountMinor: 10000, currency: 'INR',
    };
    await ledgerService.recordSettlement({ settlement, merchant });
    const after = await ledgerService.merchantBalance(merchant, 'INR');
    expect(after.balanceMinor).toBe(before.balanceMinor - 10000);
  });
});

describe('immutability', () => {
  it('refuses to update a posted entry', async () => {
    if (!guard()) return;
    const entry = await models.LedgerEntry.findOne().lean();
    await expect(
      models.LedgerEntry.updateOne({ _id: entry._id }, { $set: { amountMinor: 1 } }),
    ).rejects.toThrow(/immutable/);
  });

  it('refuses to re-save a hydrated entry', async () => {
    if (!guard()) return;
    const doc = await models.LedgerEntry.findOne();
    doc.amountMinor = 999999;
    await expect(doc.save()).rejects.toThrow(/immutable/);
  });

  it('corrects a mistake by posting a reversal, leaving history intact', async () => {
    if (!guard()) return;
    const payment = makePayment(33000, 660);
    const { journal } = await ledgerService.recordPaymentCapture({ payment, merchant });

    const reversal = await ledgerService.reverseJournal(journal.journalId, 'duplicate capture');
    expect(reversal.journal.totalDebitMinor).toBe(reversal.journal.totalCreditMinor);

    const original = await models.Journal.findOne({ journalId: journal.journalId }).lean();
    expect(original.status).toBe('REVERSED');
    expect(original.reversedByJournalId).toBe(reversal.journal.journalId);
    // Both journals still exist — nothing was erased.
    expect(await models.Journal.countDocuments({
      journalId: { $in: [journal.journalId, reversal.journal.journalId] },
    })).toBe(2);
  });
});

describe('reconciliation', () => {
  it('finds the book balanced and the accounting identity intact', async () => {
    if (!guard()) return;
    const report = await reconciliationService.run({ currency: 'INR', triggeredBy: 'test' });

    expect(report.imbalanceMinor).toBe(0);
    expect(report.totalDebitMinor).toBe(report.totalCreditMinor);
    expect(report.discrepancies).toHaveLength(0);
    expect(report.status).toBe('BALANCED');

    const trial = await reconciliationService.trialBalance({ currency: 'INR' });
    expect(trial.balanced).toBe(true);

    const sumOf = (type) => trial.accounts
      .filter((a) => a.type === type)
      .reduce((total, a) => total + a.balanceMinor, 0);
    // assets = liabilities + revenue − expenses
    expect(sumOf('ASSET')).toBe(sumOf('LIABILITY') + sumOf('REVENUE') - sumOf('EXPENSE'));
  });

  it('detects and reports drift instead of silently repairing it', async () => {
    if (!guard()) return;
    const account = await models.LedgerAccount.findOne({ code: 'platform_revenue' }).lean();
    // Simulate corruption: move the cached balance out of step with the entries.
    await models.LedgerAccount.updateOne({ _id: account._id }, { $inc: { balanceMinor: 777 } });

    const report = await reconciliationService.run({ currency: 'INR', triggeredBy: 'test-drift' });
    expect(report.status).toBe('DISCREPANCY_FOUND');
    const drift = report.discrepancies.find((d) => d.kind === 'BALANCE_DRIFT');
    expect(drift).toBeDefined();
    expect(drift.deltaMinor).toBe(777);
    expect(drift.accountCode).toBe('platform_revenue');

    // The report describes the problem; it does not rewrite the balance.
    const stillDrifted = await models.LedgerAccount.findOne({ _id: account._id }).lean();
    expect(stillDrifted.balanceMinor).toBe(account.balanceMinor + 777);

    await models.LedgerAccount.updateOne({ _id: account._id }, { $inc: { balanceMinor: -777 } });
  });
});
