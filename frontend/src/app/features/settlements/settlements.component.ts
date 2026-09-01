import { Component, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { PaymentApiService } from '../../core/services/payment.service';
import { AuthService } from '../../core/services/auth.service';
import { ToastService } from '../../core/services/toast.service';
import { Page, Settlement } from '../../core/models';
import { StatusBadgeComponent } from '../../shared/components/status-badge.component';
import { PaginationComponent } from '../../shared/components/pagination.component';
import { StatCardComponent } from '../../shared/components/stat-card.component';

/** Settlement batches: the queue awaiting payout and the completed history. */
@Component({
  selector: 'pf-settlements',
  standalone: true,
  imports: [CommonModule, FormsModule, StatusBadgeComponent, PaginationComponent, StatCardComponent],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1 class="page-title">Settlements</h1>
          <p class="page-sub">
            Captured funds are held for the merchant's window, then batched for payout
          </p>
        </div>
        @if (isAdmin()) {
          <button class="btn btn--primary btn--sm" (click)="runNow()" [disabled]="running()">
            @if (running()) { <span class="spinner"></span> } Run settlement now
          </button>
        }
      </header>

      <section class="stats">
        <pf-stat label="Awaiting payout" [value]="queue().length"
                 [hint]="queuedValue() + ' queued'" />
        <pf-stat label="Settled" [value]="countByStatus('SETTLED')" hint="paid out" />
        <pf-stat label="Failed" [value]="countByStatus('FAILED')"
                 [accent]="countByStatus('FAILED') > 0 ? 'var(--danger)' : ''"
                 hint="retried by scheduler" />
        <pf-stat label="Total net" [value]="totalNet()" prefix="₹" hint="across listed batches" />
      </section>

      @if (queue().length) {
        <section class="card">
          <div class="card-head">
            <div>
              <div class="card-title">Payout queue</div>
              <div class="card-sub">Batches built and waiting on the bank rail</div>
            </div>
          </div>
          <div class="queue-list">
            @for (item of queue(); track item.settlementId) {
              <div class="queue-item">
                <div class="queue-main">
                  <div class="mono tiny dim">{{ item.settlementId }}</div>
                  <div class="row">
                    <pf-status [status]="item.status" />
                    @if (item.merchant) { <span class="small muted">{{ item.merchant.name }}</span> }
                  </div>
                </div>
                <div class="queue-figures">
                  <div class="figure">
                    <div class="tiny dim">Gross</div>
                    <div class="num">₹{{ item.gross }}</div>
                  </div>
                  <div class="figure">
                    <div class="tiny dim">Fees</div>
                    <div class="num text-warning">−₹{{ item.fee }}</div>
                  </div>
                  <div class="figure">
                    <div class="tiny dim">Refunds</div>
                    <div class="num text-danger">−₹{{ item.refunded }}</div>
                  </div>
                  <div class="figure figure--net">
                    <div class="tiny dim">Net payout</div>
                    <div class="num strong">₹{{ item.net }}</div>
                  </div>
                  <div class="figure">
                    <div class="tiny dim">Payments</div>
                    <div class="num">{{ item.paymentCount }}</div>
                  </div>
                </div>
              </div>
            }
          </div>
        </section>
      }

      <section class="card card--flush">
        <div class="card-head history-head">
          <div class="card-title">Settlement history</div>
          <select class="select status-select" [(ngModel)]="status" (ngModelChange)="load(1)"
                  aria-label="Filter by status">
            <option value="">All statuses</option>
            <option value="QUEUED">Queued</option>
            <option value="PROCESSING">Processing</option>
            <option value="SETTLED">Settled</option>
            <option value="FAILED">Failed</option>
          </select>
        </div>
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>Settlement</th><th>Status</th><th class="num-cell">Gross</th>
                <th class="num-cell">Fees</th><th class="num-cell">Refunds</th>
                <th class="num-cell">Net</th><th class="num-cell">Payments</th>
                <th>Period</th><th>Payout ref</th>
              </tr>
            </thead>
            <tbody>
              @for (item of page()?.items ?? []; track item.settlementId) {
                <tr>
                  <td class="mono tiny">{{ item.settlementId }}</td>
                  <td><pf-status [status]="item.status" /></td>
                  <td class="num-cell">₹{{ item.gross }}</td>
                  <td class="num-cell dim">₹{{ item.fee }}</td>
                  <td class="num-cell dim">₹{{ item.refunded }}</td>
                  <td class="num-cell strong">₹{{ item.net }}</td>
                  <td class="num-cell dim">{{ item.paymentCount }}</td>
                  <td class="dim tiny">
                    {{ item.periodStart | date: 'dd MMM' }} – {{ item.periodEnd | date: 'dd MMM' }}
                  </td>
                  <td class="mono tiny dim">
                    {{ item.payout.reference ? (item.payout.reference | slice: 0:18) + '…' : '—' }}
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="9"><div class="empty">No settlements yet</div></td></tr>
              }
            </tbody>
          </table>
        </div>
        <pf-pagination [pagination]="page()?.pagination ?? null" (pageChange)="load($event)" />
      </section>
    </div>
  `,
  styles: [`
    .page { display: flex; flex-direction: column; gap: 16px; }
    .page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
    .page-title { font-size: 20px; }
    .page-sub { margin: 3px 0 0; font-size: 12px; color: var(--text-dim); }
    .stats { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
    .status-select { width: auto; min-width: 150px; }

    .queue-list { display: flex; flex-direction: column; gap: 10px; }
    .queue-item {
      display: flex; align-items: center; justify-content: space-between; gap: 20px; flex-wrap: wrap;
      padding: 13px 15px; background: var(--surface-2);
      border: 1px solid var(--border); border-radius: var(--radius-sm);
    }
    .queue-main { display: flex; flex-direction: column; gap: 6px; }
    .queue-figures { display: flex; gap: 24px; flex-wrap: wrap; }
    .figure { text-align: right; }
    .figure--net { padding-left: 16px; border-left: 1px solid var(--border); }
    .history-head { padding: 16px 18px 0; margin-bottom: 12px; }
  `],
})
export class SettlementsComponent implements OnInit {
  private readonly api = inject(PaymentApiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  readonly page = signal<Page<Settlement> | null>(null);
  readonly queue = signal<Settlement[]>([]);
  readonly running = signal(false);
  readonly isAdmin = () => this.auth.hasRole('ADMIN');

  status = '';

  ngOnInit(): void {
    this.load(1);
    this.loadQueue();
  }

  load(page: number): void {
    this.api.listSettlements({ page, limit: 20, status: this.status || undefined })
      .subscribe({ next: (result) => this.page.set(result), error: () => undefined });
  }

  loadQueue(): void {
    this.api.settlementQueue()
      .subscribe({ next: (list) => this.queue.set(list), error: () => undefined });
  }

  countByStatus(status: string): number {
    return (this.page()?.items ?? []).filter((item) => item.status === status).length;
  }

  totalNet(): string {
    const total = (this.page()?.items ?? []).reduce((sum, item) => sum + item.netAmountMinor, 0);
    return (total / 100).toFixed(2);
  }

  queuedValue(): string {
    const total = this.queue().reduce((sum, item) => sum + item.netAmountMinor, 0);
    return `₹${(total / 100).toFixed(2)}`;
  }

  /**
   * Force a settlement build.
   *
   * Safe to press twice: the server derives a deterministic batch key from
   * (merchant, currency, window), so a second run in the same window returns
   * the existing batch instead of paying the merchant twice.
   */
  runNow(): void {
    const merchantId = this.auth.merchant()?.merchantId;
    if (!merchantId) {
      this.toast.warning('Choose a merchant', 'A settlement run needs a merchant context.');
      return;
    }
    this.running.set(true);
    this.api.runSettlement(merchantId).subscribe({
      next: (settlement) => {
        this.running.set(false);
        if (settlement) {
          this.toast.success('Settlement built', `₹${settlement.net} queued for payout`);
        } else {
          this.toast.info('Nothing to settle', 'No payments are past their hold window yet.');
        }
        this.load(1);
        this.loadQueue();
      },
      error: () => this.running.set(false),
    });
  }
}
