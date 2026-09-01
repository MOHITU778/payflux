import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Subject, debounceTime, distinctUntilChanged } from 'rxjs';
import { PaymentApiService } from '../../core/services/payment.service';
import { Page, Payment, PaymentStatus, QueryParams } from '../../core/models';
import { StatusBadgeComponent } from '../../shared/components/status-badge.component';
import { PaginationComponent } from '../../shared/components/pagination.component';

const STATUSES: PaymentStatus[] = [
  'SUCCESS', 'FAILED', 'PENDING', 'PROCESSING', 'REFUNDED', 'PARTIALLY_REFUNDED', 'CANCELLED',
];

/**
 * Transaction browser: search, filter, sort, paginate.
 *
 * Search is debounced by 350ms. Firing a query per keystroke would issue a
 * request for every prefix of what the user types — mostly for results nobody
 * will ever see — and hammer the API for no benefit.
 */
@Component({
  selector: 'pf-transactions',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, StatusBadgeComponent, PaginationComponent],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1 class="page-title">Transactions</h1>
          <p class="page-sub">
            @if (page(); as p) { {{ p.pagination.total | number }} payments } @else { Loading… }
          </p>
        </div>
        <button class="btn btn--sm" (click)="load()" [disabled]="loading()">
          @if (loading()) { <span class="spinner"></span> } @else { ↻ } Refresh
        </button>
      </header>

      <!-- ── Filters ───────────────────────────────────────────────── -->
      <div class="card filters">
        <div class="filter-grid">
          <div>
            <label class="label" for="q">Payment ID</label>
            <input id="q" class="input" placeholder="pay_…" [(ngModel)]="searchTerm"
                   (ngModelChange)="search$.next($event)" />
          </div>
          <div>
            <label class="label" for="status">Status</label>
            <select id="status" class="select" [(ngModel)]="status" (ngModelChange)="load(1)">
              <option value="">All statuses</option>
              @for (option of statuses; track option) {
                <option [value]="option">{{ option.replace('_', ' ') }}</option>
              }
            </select>
          </div>
          <div>
            <label class="label" for="method">Method</label>
            <select id="method" class="select" [(ngModel)]="method" (ngModelChange)="load(1)">
              <option value="">All methods</option>
              <option value="CARD">Card</option>
              <option value="UPI">UPI</option>
              <option value="NETBANKING">Net banking</option>
              <option value="WALLET">Wallet</option>
            </select>
          </div>
          <div>
            <label class="label" for="from">From</label>
            <input id="from" class="input" type="date" [(ngModel)]="from" (ngModelChange)="load(1)" />
          </div>
          <div>
            <label class="label" for="to">To</label>
            <input id="to" class="input" type="date" [(ngModel)]="to" (ngModelChange)="load(1)" />
          </div>
          <div>
            <label class="label" for="sort">Sort</label>
            <select id="sort" class="select" [(ngModel)]="sort" (ngModelChange)="load(1)">
              <option value="-createdAt">Newest first</option>
              <option value="createdAt">Oldest first</option>
              <option value="-amountMinor">Amount, high to low</option>
              <option value="amountMinor">Amount, low to high</option>
            </select>
          </div>
        </div>
        @if (hasFilters()) {
          <div class="filter-foot">
            <button class="btn btn--sm btn--ghost" (click)="clearFilters()">Clear filters</button>
          </div>
        }
      </div>

      <!-- ── Results ───────────────────────────────────────────────── -->
      <div class="card card--flush">
        <div class="table-wrap">
          <table class="data">
            <thead>
              <tr>
                <th>Payment ID</th><th>Status</th><th>Method</th>
                <th class="num-cell">Amount</th><th class="num-cell">Refunded</th>
                <th class="num-cell">Risk</th><th>Customer</th><th>Created</th><th></th>
              </tr>
            </thead>
            <tbody>
              @if (loading() && !page()) {
                @for (row of skeletonRows; track row) {
                  <tr><td colspan="9"><div class="skeleton" style="height:18px"></div></td></tr>
                }
              } @else {
                @for (payment of page()?.items ?? []; track payment.paymentId) {
                  <tr class="clickable" [routerLink]="['/transactions', payment.paymentId]">
                    <td class="mono tiny">{{ payment.paymentId }}</td>
                    <td><pf-status [status]="payment.status" /></td>
                    <td class="dim">{{ payment.method }}</td>
                    <td class="num-cell strong">₹{{ payment.amount }}</td>
                    <td class="num-cell dim">
                      @if (payment.amountRefundedMinor > 0) { ₹{{ payment.amountRefunded }} }
                      @else { — }
                    </td>
                    <td class="num-cell">
                      <span [class.text-danger]="payment.risk.score >= 80"
                            [class.text-warning]="payment.risk.score >= 50 && payment.risk.score < 80">
                        {{ payment.risk.score }}
                      </span>
                    </td>
                    <td class="dim tiny">{{ payment.customer.email ?? '—' }}</td>
                    <td class="dim tiny">{{ payment.createdAt | date: 'dd MMM yy, HH:mm' }}</td>
                    <td class="dim">›</td>
                  </tr>
                } @empty {
                  <tr><td colspan="9">
                    <div class="empty">
                      No payments match these filters.
                      @if (hasFilters()) {
                        <button class="btn btn--sm btn--ghost" (click)="clearFilters()">Clear filters</button>
                      }
                    </div>
                  </td></tr>
                }
              }
            </tbody>
          </table>
        </div>
        <pf-pagination [pagination]="page()?.pagination ?? null" (pageChange)="load($event)" />
      </div>
    </div>
  `,
  styles: [`
    .page { display: flex; flex-direction: column; gap: 16px; }
    .page-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
    .page-title { font-size: 20px; }
    .page-sub { margin: 3px 0 0; font-size: 12px; color: var(--text-dim); }
    .filters { padding: 16px 18px; }
    .filter-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); }
    .filter-foot { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
    .clickable { cursor: pointer; }
  `],
})
export class TransactionsComponent implements OnInit, OnDestroy {
  private readonly api = inject(PaymentApiService);

  readonly statuses = STATUSES;
  readonly skeletonRows = Array.from({ length: 8 }, (_, i) => i);

  readonly page = signal<Page<Payment> | null>(null);
  readonly loading = signal(false);

  searchTerm = '';
  status = '';
  method = '';
  from = '';
  to = '';
  sort = '-createdAt';

  readonly search$ = new Subject<string>();

  ngOnInit(): void {
    // Debounce keystrokes into a single query once typing settles.
    this.search$
      .pipe(debounceTime(350), distinctUntilChanged())
      .subscribe(() => this.load(1));
    this.load();
  }

  ngOnDestroy(): void { this.search$.complete(); }

  hasFilters(): boolean {
    return Boolean(this.searchTerm || this.status || this.method || this.from || this.to);
  }

  clearFilters(): void {
    this.searchTerm = ''; this.status = ''; this.method = ''; this.from = ''; this.to = '';
    this.load(1);
  }

  load(page = this.page()?.pagination.page ?? 1): void {
    this.loading.set(true);
    const query: QueryParams = { page, limit: 20, sort: this.sort };
    if (this.searchTerm.trim()) query['paymentId'] = this.searchTerm.trim();
    if (this.status) query['status'] = this.status;
    if (this.method) query['method'] = this.method;
    // Widen the end date to the whole day, which is what a user picking a date
    // in a date input actually means.
    if (this.from) query['from'] = new Date(this.from).toISOString();
    if (this.to) query['to'] = new Date(`${this.to}T23:59:59.999Z`).toISOString();

    this.api.listPayments(query).subscribe({
      next: (result) => { this.page.set(result); this.loading.set(false); },
      error: () => this.loading.set(false),
    });
  }
}
