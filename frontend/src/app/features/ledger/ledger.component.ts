import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { PaymentApiService } from '../../core/services/payment.service';
import { ToastService } from '../../core/services/toast.service';
import { AuthService } from '../../core/services/auth.service';
import { Page, Reconciliation, TrialBalance } from '../../core/models';
import { StatusBadgeComponent } from '../../shared/components/status-badge.component';
import { StatCardComponent } from '../../shared/components/stat-card.component';

/**
 * Ledger and reconciliation view.
 *
 * The headline is the trial balance: total debits against total credits. In a
 * correct double-entry system these are equal, so the single most useful thing
 * this page can show is whether they are — and if not, exactly where the
 * divergence is.
 */
@Component({
  selector: 'pf-ledger',
  standalone: true,
  imports: [CommonModule, StatusBadgeComponent, StatCardComponent],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1 class="page-title">Ledger</h1>
          <p class="page-sub">Double-entry books and reconciliation</p>
        </div>
        @if (isAdmin()) {
          <button class="btn btn--primary btn--sm" (click)="runReconciliation()" [disabled]="running()">
            @if (running()) { <span class="spinner"></span> } Run reconciliation
          </button>
        }
      </header>

      <!-- ── Trial balance headline ────────────────────────────────── -->
      @if (trial(); as t) {
        <section class="balance-banner" [class.balance-banner--ok]="t.balanced"
                 [class.balance-banner--bad]="!t.balanced">
          <div class="banner-icon" aria-hidden="true">{{ t.balanced ? '✓' : '!' }}</div>
          <div class="banner-body">
            <div class="banner-title">
              {{ t.balanced ? 'Books are balanced' : 'Ledger imbalance detected' }}
            </div>
            <div class="banner-sub small">
              Total debits <span class="mono strong">₹{{ major(t.totalDebitMinor) }}</span>
              {{ t.balanced ? '=' : '≠' }}
              total credits <span class="mono strong">₹{{ major(t.totalCreditMinor) }}</span>
              · {{ t.entryCount | number }} entries
            </div>
          </div>
        </section>

        <!-- ── Accounting identity ───────────────────────────────── -->
        <section class="stats">
          <pf-stat label="Assets" [value]="major(sumType('ASSET'))" prefix="₹"
                   hint="gateway clearing" />
          <pf-stat label="Liabilities" [value]="major(sumType('LIABILITY'))" prefix="₹"
                   hint="owed to merchants" />
          <pf-stat label="Revenue" [value]="major(sumType('REVENUE'))" prefix="₹"
                   hint="platform fees" accent="var(--success)" />
          <pf-stat label="Identity check" [value]="identityHolds() ? 'Holds' : 'Broken'"
                   [accent]="identityHolds() ? 'var(--success)' : 'var(--danger)'"
                   hint="assets = liabilities + revenue − expenses" />
        </section>

        <!-- ── Chart of accounts ─────────────────────────────────── -->
        <section class="card card--flush">
          <div class="card-head accounts-head">
            <div>
              <div class="card-title">Chart of accounts</div>
              <div class="card-sub">Balances recomputed from the immutable entry stream</div>
            </div>
          </div>
          <div class="table-wrap">
            <table class="data">
              <thead>
                <tr>
                  <th>Account</th><th>Type</th><th>Normal balance</th>
                  <th class="num-cell">Debits</th><th class="num-cell">Credits</th>
                  <th class="num-cell">Balance</th><th class="num-cell">Entries</th>
                </tr>
              </thead>
              <tbody>
                @for (account of t.accounts; track account.code) {
                  <tr>
                    <td>
                      <div class="mono small">{{ account.code }}</div>
                      <div class="tiny dim">{{ account.name }}</div>
                    </td>
                    <td><span class="badge badge--neutral">{{ account.type }}</span></td>
                    <td class="tiny dim">{{ normalBalance(account.type) }}</td>
                    <td class="num-cell dim">₹{{ major(account.totalDebitMinor) }}</td>
                    <td class="num-cell dim">₹{{ major(account.totalCreditMinor) }}</td>
                    <td class="num-cell strong">₹{{ major(account.balanceMinor) }}</td>
                    <td class="num-cell dim">{{ account.entryCount }}</td>
                  </tr>
                } @empty {
                  <tr><td colspan="7"><div class="empty">No accounts yet</div></td></tr>
                }
              </tbody>
            </table>
          </div>
        </section>
      } @else {
        <div class="card"><div class="skeleton" style="height:100px"></div></div>
      }

      <!-- ── Reconciliation history ────────────────────────────────── -->
      <section class="card card--flush">
        <div class="card-head accounts-head">
          <div>
            <div class="card-title">Reconciliation runs</div>
            <div class="card-sub">
              Each run recomputes balances from entries and reports drift — it never silently repairs
            </div>
          </div>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>Run</th><th>Status</th><th class="num-cell">Accounts</th>
                <th class="num-cell">Entries</th><th class="num-cell">Imbalance</th>
                <th class="num-cell">Discrepancies</th><th class="num-cell">Duration</th><th>When</th>
              </tr>
            </thead>
            <tbody>
              @for (run of runs()?.items ?? []; track run.runId) {
                <tr>
                  <td class="mono tiny">{{ run.runId }}</td>
                  <td><pf-status [status]="run.status" /></td>
                  <td class="num-cell dim">{{ run.accountsChecked }}</td>
                  <td class="num-cell dim">{{ run.entriesChecked | number }}</td>
                  <td class="num-cell" [class.text-danger]="run.imbalanceMinor !== 0">
                    {{ run.imbalanceMinor === 0 ? '0' : '₹' + major(run.imbalanceMinor) }}
                  </td>
                  <td class="num-cell" [class.text-danger]="run.discrepancies.length > 0">
                    {{ run.discrepancies.length }}
                  </td>
                  <td class="num-cell dim">{{ run.durationMs }}ms</td>
                  <td class="dim tiny">{{ run.createdAt | date: 'dd MMM HH:mm:ss' }}</td>
                </tr>
                @if (run.discrepancies.length) {
                  <tr class="discrepancy-row">
                    <td colspan="8">
                      @for (item of run.discrepancies; track $index) {
                        <div class="discrepancy">
                          <span class="badge badge--danger">{{ item.kind }}</span>
                          <span class="mono tiny">{{ item.accountCode ?? item.journalId }}</span>
                          <span class="tiny muted">{{ item.detail }}</span>
                          @if (item.deltaMinor !== null) {
                            <span class="tiny text-danger">Δ ₹{{ major(item.deltaMinor) }}</span>
                          }
                        </div>
                      }
                    </td>
                  </tr>
                }
              } @empty {
                <tr><td colspan="8"><div class="empty">
                  No reconciliation runs yet. The scheduler runs one every 12 hours.
                </div></td></tr>
              }
            </tbody>
          </table>
        </div>
      </section>
    </div>
  `,
  styles: [`
    .page { display: flex; flex-direction: column; gap: 16px; }
    .page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
    .page-title { font-size: 20px; }
    .page-sub { margin: 3px 0 0; font-size: 12px; color: var(--text-dim); }
    .stats { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); }

    .balance-banner {
      display: flex; align-items: center; gap: 16px;
      padding: 18px 20px; border-radius: var(--radius); border: 1px solid;
    }
    .balance-banner--ok { background: var(--success-soft); border-color: var(--success); }
    .balance-banner--bad { background: var(--danger-soft); border-color: var(--danger); }
    .banner-icon {
      width: 38px; height: 38px; border-radius: 50%;
      display: grid; place-items: center; font-size: 19px; font-weight: 700; flex-shrink: 0;
    }
    .balance-banner--ok .banner-icon { background: var(--success); color: #04120c; }
    .balance-banner--bad .banner-icon { background: var(--danger); color: #fff; }
    .banner-title { font-size: 15px; font-weight: 650; }
    .banner-sub { color: var(--text-muted); margin-top: 3px; }
    .balance-banner--ok .banner-title { color: var(--success); }
    .balance-banner--bad .banner-title { color: var(--danger); }

    .accounts-head { padding: 16px 18px 0; margin-bottom: 12px; }
    .discrepancy-row td { background: var(--danger-soft); padding: 10px 16px; }
    .discrepancy { display: flex; align-items: center; gap: 10px; padding: 3px 0; flex-wrap: wrap; }
  `],
})
export class LedgerComponent implements OnInit {
  private readonly api = inject(PaymentApiService);
  private readonly toast = inject(ToastService);
  private readonly auth = inject(AuthService);

  readonly trial = signal<TrialBalance | null>(null);
  readonly runs = signal<Page<Reconciliation> | null>(null);
  readonly running = signal(false);
  readonly isAdmin = () => this.auth.hasRole('ADMIN');

  ngOnInit(): void { this.load(); }

  private load(): void {
    this.api.trialBalance({ currency: 'INR' })
      .subscribe({ next: (data) => this.trial.set(data), error: () => undefined });
    this.api.reconciliations({ limit: 10 })
      .subscribe({ next: (page) => this.runs.set(page), error: () => undefined });
  }

  major(minor: number): string {
    return (minor / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  sumType(type: string): number {
    return (this.trial()?.accounts ?? [])
      .filter((account) => account.type === type)
      .reduce((total, account) => total + account.balanceMinor, 0);
  }

  /** assets = liabilities + revenue − expenses */
  identityHolds(): boolean {
    if (!this.trial()) return true;
    return this.sumType('ASSET') === this.sumType('LIABILITY') + this.sumType('REVENUE') - this.sumType('EXPENSE');
  }

  /** Which side increases this account type. */
  normalBalance(type: string): string {
    return type === 'ASSET' || type === 'EXPENSE' ? 'Debit' : 'Credit';
  }

  runReconciliation(): void {
    this.running.set(true);
    this.api.runReconciliation('INR').subscribe({
      next: (report) => {
        this.running.set(false);
        if (report.status === 'BALANCED') {
          this.toast.success('Ledger balanced', `${report.entriesChecked} entries checked`);
        } else {
          this.toast.warning('Discrepancies found', `${report.discrepancies.length} issue(s) reported`);
        }
        this.load();
      },
      error: () => this.running.set(false),
    });
  }
}
